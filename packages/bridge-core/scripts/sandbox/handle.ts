/** The run handle: strings only, so it crosses a process boundary and vitest's `provide()` intact.
 *  `openSandbox` turns it back into connected clients for whichever process holds it. */
import { z } from "zod"
import type { L1Ctx } from "../../src/flows"
import type { ManifestV2 } from "../../src/manifest-v2"
import { manifestV2Schema } from "../../src/manifest-v2"
import { createL1Clients } from "../script-bootstrap"
import { privateKeyToAccount } from "viem/accounts"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ARTIFACT_FILES } from "./manifest"
import { CHAIN_ID, sandboxChain } from "./constants"
import type { L1Deployment } from "./l1"
import { adoptGuardian, connectL2, type L2Base } from "./l2"
import { stopwatch } from "../script-bootstrap"

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export const sandboxHandleSchema = z
	.object({
		anvilUrl: z.string().url(),
		nodeUrl: z.string().url(),
		l1ChainId: z.literal(CHAIN_ID),
		rollupVersion: z.number().int().nonnegative(),
		walletChainId: z.number().int().nonnegative(),
		artifactsDir: z.string(),
		l1: z.object({
			/** Deploys, relays, and is `l1` in every flow — anvil's last funded index, never index 0, which
			 *  the local network's publisher signs from. */
			deployerKey: hex,
			/** Anvil indices 1..: one per browser spec file. */
			actorKeys: z.array(hex),
		}),
		l2: z.object({
			relayer: hex,
			/** The base actor the generation was deployed by; its address is derivable from the secret. */
			actorSecret: hex,
			actorSalt: z.string(),
		}),
		deployment: z.object({
			feeJuice: address,
			feeJuicePortal: address,
			registry: address,
			swapTarget: address,
			quoter: address,
			tokens: z.record(z.string(), address),
		}),
	})
	.strict()

export type SandboxHandle = z.infer<typeof sandboxHandleSchema>

export function readHandle(dir: string): SandboxHandle {
	return sandboxHandleSchema.parse(JSON.parse(readFileSync(join(dir, ARTIFACT_FILES.handle), "utf8")))
}

export function readManifest(dir: string): ManifestV2 {
	return manifestV2Schema.parse(JSON.parse(readFileSync(join(dir, ARTIFACT_FILES.manifest), "utf8")))
}

export interface SandboxClients {
	handle: SandboxHandle
	l1: L1Ctx
	l1b: L1Ctx
	l2: L2Base
	deployment: L1Deployment
	mins: () => string
}

/** Connected clients for a handle. The Node embedded wallet here is a scripting wallet: it holds
 *  the relayer and creates actors; it is never the wallet under test. */
export async function openSandbox(handle: SandboxHandle): Promise<SandboxClients> {
	const chain = sandboxChain(handle.anvilUrl)
	// One writer per key per process, sends in sequence: every flow awaits each L1 write, and the one
	// concurrent shape (two first-time deposits) uses two keys. viem's nonce manager is deliberately
	// NOT used — it keeps counting past a send that reverted at gas estimation, and the battery
	// reverts on purpose. A second process attached to the same handle races these keys on chain.
	const account = privateKeyToAccount(handle.l1.deployerKey as `0x${string}`)
	const second = privateKeyToAccount((handle.l1.actorKeys[0] ?? handle.l1.deployerKey) as `0x${string}`)
	const l1: L1Ctx = { ...createL1Clients({ chain, rpcUrl: handle.anvilUrl, account }), account }
	const l1b: L1Ctx = { ...createL1Clients({ chain, rpcUrl: handle.anvilUrl, account: second }), account: second }
	const l2 = await connectL2(handle.nodeUrl)
	await adoptGuardian(l2, handle.l2.actorSecret as `0x${string}`, BigInt(handle.l2.actorSalt))
	return {
		handle,
		l1,
		l1b,
		l2,
		deployment: handle.deployment as unknown as L1Deployment,
		mins: stopwatch(),
	}
}
