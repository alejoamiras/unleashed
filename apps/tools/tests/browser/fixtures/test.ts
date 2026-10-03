/**
 * The suite's `test`: one context per spec file with the L1 shim, the egress fence and the parked
 * wallet panel installed; the sandbox and an actor pool per file; a fresh actor per test.
 *
 * Actors are created in Node BEFORE the wallet frame exists and reach it through a context-level
 * init script (the SDK creates the session iframe only inside `establishSecureChannel`, so a page
 * script could never be early enough). The wallet imports every seed before it answers the grant,
 * so the switcher lists the whole pool from the first connect. Two spares cover retries.
 */
import { test as base, type BrowserContext, expect, type Page } from "@playwright/test"
import { l2CtxFor, readHandle } from "@unleashed/bridge-core/sandbox"
import { type RunEnv, runEnv } from "../env"
import type { Seed } from "../test-wallet/profile"
import { confineEgress, type Egress, type TokenListFixture } from "./egress"
import { installL1Wallet, type L1WalletControl } from "./l1-wallet"
import { type ActorHandle, type SandboxAccess, sandboxAccess } from "./sandbox"
import { parkWalletPanel } from "./wallet-panel"

/** Tools caps a grant at 16 accounts; a file whose cells need more is split. */
export const MAX_POOL = 16
const SPARES = 2
/** The local network builds a block only when a transaction arrives, and a claim waits on the
 *  L1→L2 message reaching a block: the relayer nudges one this often for the worker's whole life. */
const HEARTBEAT_MS = 3_000

export interface ActorPool {
	all: ActorHandle[]
	/** The next unused actor; a retry gets a spare, never one a prior attempt touched. */
	take(): ActorHandle
}

interface Fixtures {
	l1: L1WalletControl
	egress: Egress
	actor: ActorHandle
	page: Page
}

/** Worker-scoped = per spec file: Playwright reuses a worker across files whose worker options
 *  agree, so every file names itself in `family` and gets a worker — and a pool — of its own. */
interface WorkerFixtures {
	/** The spec file's own name — `test.use({ family: "exits" })` — unique per file, never shared. */
	family: string
	/** How many cells the file declares — `test.use({ cells: N })` at the top of a spec. */
	cells: number
	/** Which anvil key this file signs with — `test.use({ l1Index: i })`. Files may share one: with
	 *  a single worker they run in sequence, and a shard runs on a sandbox of its own. */
	l1Index: number
	/** Extra actors beyond `cells` (retries take them). A file that must connect a wallet holding
	 *  EXACTLY `cells` accounts sets 0 — and then has no retry budget. */
	spares: number
	/** The fixture the egress fence answers the community token list from — `test.use({ tokenList: "hostile" })`. */
	tokenList: TokenListFixture
	run: RunEnv
	sandbox: SandboxAccess
	pool: ActorPool
	/** Side effect only: the relayer's block heartbeat, running for the worker's whole life. */
	heartbeat: undefined
}

export const test = base.extend<Fixtures, WorkerFixtures>({
	family: ["", { option: true, scope: "worker" }],
	cells: [1, { option: true, scope: "worker" }],
	l1Index: [0, { option: true, scope: "worker" }],
	spares: [SPARES, { option: true, scope: "worker" }],
	tokenList: ["community", { option: true, scope: "worker" }],

	run: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructuring form even with no dependencies.
		async ({}, use) => {
			await use(runEnv())
		},
		{ scope: "worker" },
	],

	sandbox: [
		// biome-ignore lint/correctness/noEmptyPattern: Playwright requires the destructuring form even with no dependencies.
		async ({}, use) => {
			await use(await sandboxAccess())
		},
		{ scope: "worker" },
	],

	heartbeat: [
		async ({ sandbox }, use) => {
			const l2 = l2CtxFor(sandbox.clients.l2, sandbox.clients.l2.relayer)
			let beating = false
			const timer = setInterval(() => {
				if (beating) return
				beating = true
				void l2
					.forceBlock?.()
					.catch(() => {})
					.finally(() => {
						beating = false
					})
			}, HEARTBEAT_MS)
			await use(undefined)
			clearInterval(timer)
		},
		{ scope: "worker", auto: true },
	],

	pool: [
		async ({ sandbox, cells, family, spares }, use) => {
			if (!family) throw new Error("a spec file must name itself: test.use({ family: <its name>, cells, l1Index })")
			const n = cells + spares
			if (n > MAX_POOL)
				throw new Error(`a file declaring ${cells} cells needs ${n} actors, above the grant cap of ${MAX_POOL} — split it`)
			const all: ActorHandle[] = []
			for (let i = 0; i < n; i++) all.push(await sandbox.newActor())
			let next = 0
			await use({
				all,
				take() {
					const a = all[next++]
					if (!a) throw new Error("the file's actor pool is exhausted (cells + spares)")
					return a
				},
			})
		},
		{ scope: "worker" },
	],

	context: async ({ context, run, l1Index, pool }, use) => {
		const handle = readHandle(run.artifactsDir)
		const key = handle.l1.actorKeys[l1Index]
		if (!key) throw new Error(`no anvil actor key at index ${l1Index}`)
		const walletOrigins = Object.values(run.testWalletOrigins)
		await installSeeds(
			context,
			walletOrigins,
			pool.all.map((a) => a.seed),
		)
		await parkWalletPanel(context, walletOrigins)
		await installL1WalletControl(context, { rpcUrl: handle.anvilUrl, privateKey: key as `0x${string}`, chainId: handle.l1ChainId })
		await use(context)
	},

	l1: async ({ context }, use) => {
		const control = controls.get(context)
		if (!control) throw new Error("the L1 wallet is installed by the context fixture")
		await use(control)
	},

	egress: [
		async ({ context, tokenList }, use) => {
			const egress = await confineEgress(context, tokenList)
			await use(egress)
			expect(egress.blocked, "every request stayed on loopback").toEqual([])
		},
		{ auto: true },
	],

	actor: async ({ pool }, use) => {
		await use(pool.take())
	},

	// The app's own log lines and every error, from both frames, land in the runner's output — the
	// trace has them too, but a failure should be readable from the log alone.
	page: async ({ page }, use) => {
		page.on("console", (msg) => {
			const text = msg.text()
			if (text.startsWith("[bridge") || text.startsWith("[test-wallet") || msg.type() === "error")
				console.log(`[page] ${text.slice(0, 300)}`)
		})
		page.on("pageerror", (err) => console.log(`[pageerror] ${err.message.slice(0, 300)}`))
		await use(page)
	},
})

export { expect }
export type { ActorHandle, SandboxAccess }

/** The seeds reach the wallet ORIGINS' documents only — the tools page never sees them. */
async function installSeeds(context: BrowserContext, walletOrigins: string[], seeds: Seed[]): Promise<void> {
	await context.addInitScript(
		([origins, list]) => {
			if (origins.includes(location.origin)) window.__unleashedTestWalletSeeds = list
		},
		[walletOrigins, seeds] as const,
	)
}

// One install per context: a second `exposeFunction` of the same name is refused by Playwright.
const controls = new WeakMap<BrowserContext, L1WalletControl>()
async function installL1WalletControl(context: BrowserContext, o: Parameters<typeof installL1Wallet>[1]): Promise<L1WalletControl> {
	let c = controls.get(context)
	if (!c) {
		c = await installL1Wallet(context, o)
		controls.set(context, c)
	}
	return c
}
