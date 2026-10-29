/**
 * Fee Juice for a deployer that has no sponsor and no other source of it: an L1 deposit into the canonical portal,
 * claimed on L2. L1 is the only ledger. Each funding is a `DepositToAztecPublic` to the deployer, sent by the pinned
 * funding key straight to the portal, under a secret derived from the deployer's seed, so a re-run finds every
 * funding it made and resumes one it never claimed, with nothing stored locally. The funding key's nonce keeps two
 * runs from both funding one shortfall: a decision binds it (`drip-deploy.ts`).
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { poseidon2HashWithSeparator } from "@aztec-labs/foundation/crypto/sync"
import { computeSecretHash, siloNullifier } from "@aztec-labs/stdlib/hash"
import { computeFeeJuiceMessageNullifier } from "@aztec-labs/stdlib/messaging"
import { type Address, decodeFunctionData, formatUnits, type Hex, parseUnits, type PublicClient } from "viem"
import { feeJuiceAddress } from "../src/fee-juice"
import type { L1Ctx } from "../src/flows"
import { FeeJuicePortalAbi } from "../src/fuel"
import type { ManifestV2 } from "../src/manifest-v2"
import { assertCanonicalPortal } from "./fuel-route"
import { assertMainnetIdentity, MAINNET_REGISTRY, type NodeIdentity } from "./live-intent"

/** Off-chain only: no contract derives a funding secret, so the separator only has to differ from every other
 *  derivation the deployer's seed feeds. */
export const DOM_SEP__DEPLOYER_FUNDING = 0x66756e64

/** The secret of the deployer's `n`-th funding (from 1). Public deposits are bound to their recipient, so a leaked
 *  secret lets anyone claim the funding only to the deployer itself. */
export const fundingSecret = (seed: Fr, n: number): Fr => poseidon2HashWithSeparator([seed, new Fr(n)], DOM_SEP__DEPLOYER_FUNDING)

/**
 * The address of the single-purpose key that funds the mainnet Drip deployer. `null` until the owner creates the
 * key, and every mainnet funding is refused while it is: pin the address in a reviewed commit first.
 */
export const MAINNET_DRIP_FUNDER: Address | null = null

/** Fail-closed lookup of {@link MAINNET_DRIP_FUNDER}. */
export function requireMainnetDripFunder(): Address {
	if (!MAINNET_DRIP_FUNDER) {
		throw new Error("no pinned Drip funding key — pin its address in MAINNET_DRIP_FUNDER (deployer-funding.ts) first. STOP.")
	}
	return MAINNET_DRIP_FUNDER
}

/** The block each canonical portal first held code at: no deposit into it can be older. A portal without an entry
 *  is refused, so a canonical-rollup switch cannot scan a new portal from a block that misses its fundings. */
const PORTAL_FIRST_BLOCKS: Readonly<Record<string, bigint>> = {
	"0x534361be805ca30bdb6404ec5e6cdaffb3e9f3b3": 26_160_102n,
}

/** How far below the head a mainnet scan stops. A load-balanced RPC can answer the head from one backend and the
 *  logs from a lagging one; a funding that lagging backend has not indexed would be neither counted against the
 *  cap nor claimed, while the funder's nonce already shows it mined. The nonce check covers the blocks above. */
export const MAINNET_SCAN_CONFIRMATIONS = 12n

export function scanStartFor(portal: Address): bigint {
	const block = PORTAL_FIRST_BLOCKS[portal.toLowerCase()]
	if (block === undefined) throw new Error(`no pinned first block for portal ${portal} — STOP`)
	return block
}

/**
 * Where a mainnet funding may go: the node must be mainnet's as `manifest` records it, on `rollupVersion`, and the
 * manifest's portal must be the one the pinned registry's canonical rollup names, paying the manifest's asset. A
 * registry keeps older rollups whose portals still take deposits, so the node's word alone is not enough.
 */
export async function assertFundingDestination(
	l1: Pick<L1Ctx, "pub">,
	identity: NodeIdentity,
	manifest: ManifestV2,
	rollupVersion: number,
): Promise<void> {
	assertMainnetIdentity(identity, manifest)
	if (identity.rollupVersion !== rollupVersion) {
		throw new Error(`the node serves rollup version ${identity.rollupVersion}, this build pins ${rollupVersion} — STOP`)
	}
	await assertCanonicalPortal(l1, {
		registry: MAINNET_REGISTRY as Address,
		feeJuicePortal: manifest.feeJuice.portal as Address,
		feeJuice: manifest.feeJuice.asset as Address,
		rollupVersion,
	})
}

/** One authenticated funding as the portal recorded it. `key` is the L1→L2 message hash. */
export interface Funding {
	txHash: Hex
	amount: bigint
	secretHash: Hex
	key: Hex
	leafIndex: bigint
}

/** A funding this deployer's seed can claim: the preimage of its message's claim. */
export interface Claimable {
	amount: bigint
	key: Hex
	leafIndex: bigint
	n: number
	secret: Fr
}

const eq = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase()

interface PortalLog {
	address: Address
	transactionHash: Hex | null
	args: { to?: Hex; amount?: bigint; secretHash?: Hex; key?: Hex; index?: bigint }
}

/**
 * Anyone can deposit to any recipient under a copied secret hash, so a log counts only when its transaction was
 * sent by `funder` directly to the portal and its calldata is the deposit the event reports.
 */
export function authenticFunding(
	log: PortalLog,
	tx: { from: Address; to: Address | null; input: Hex },
	o: { portal: Address; recipient: Hex; funder: Address },
): Funding | undefined {
	const { to, amount, secretHash, key, index } = log.args
	if (!log.transactionHash || !eq(log.address, o.portal) || !eq(to, o.recipient)) return undefined
	if (amount === undefined || !secretHash || !key || index === undefined) return undefined
	if (!eq(tx.from, o.funder) || !eq(tx.to, o.portal)) return undefined
	let call: ReturnType<typeof decodeFunctionData<typeof FeeJuicePortalAbi>>
	try {
		call = decodeFunctionData({ abi: FeeJuicePortalAbi, data: tx.input })
	} catch {
		return undefined
	}
	if (call.functionName !== "depositToAztecPublic") return undefined
	const [callTo, callAmount, callSecretHash] = call.args as readonly [Hex, bigint, Hex]
	if (!eq(callTo, o.recipient) || callAmount !== amount || !eq(callSecretHash, secretHash)) return undefined
	return { txHash: log.transactionHash, amount, secretHash, key, leafIndex: index }
}

/** Free RPC plans cap a log query at 10,000 blocks. */
const SCAN_WINDOW = 10_000n

/** Every authenticated funding of `recipient` in `[fromBlock, toBlock]`, oldest first. */
export async function scanFundings(
	pub: Pick<PublicClient, "getContractEvents" | "getTransaction">,
	o: { portal: Address; recipient: Hex; funder: Address; fromBlock: bigint; toBlock: bigint },
): Promise<Funding[]> {
	const out: Funding[] = []
	for (let from = o.fromBlock; from <= o.toBlock; from += SCAN_WINDOW) {
		const to = from + SCAN_WINDOW - 1n < o.toBlock ? from + SCAN_WINDOW - 1n : o.toBlock
		const logs = (await pub.getContractEvents({
			address: o.portal,
			abi: FeeJuicePortalAbi,
			eventName: "DepositToAztecPublic",
			args: { to: o.recipient },
			fromBlock: from,
			toBlock: to,
		})) as unknown as PortalLog[]
		for (const log of logs) {
			if (!log.transactionHash) continue
			const tx = await pub.getTransaction({ hash: log.transactionHash })
			const funding = authenticFunding(log, tx, o)
			if (funding) out.push(funding)
		}
	}
	return out
}

/** The fundings `seed` derived, and the next unused funding number. A tool-made funding takes the number after
 *  the highest matched one, so `fundings.length` bounds every number in use. */
export async function matchFundings(fundings: readonly Funding[], seed: Fr): Promise<{ matched: (Funding & Claimable)[]; next: number }> {
	const byHash = new Map<string, { n: number; secret: Fr }>()
	for (let n = 1; n <= fundings.length; n++) {
		const secret = fundingSecret(seed, n)
		byHash.set((await computeSecretHash(secret)).toString().toLowerCase(), { n, secret })
	}
	const matched: (Funding & Claimable)[] = []
	for (const f of fundings) {
		const derived = byHash.get(f.secretHash.toLowerCase())
		if (derived) matched.push({ ...f, ...derived })
	}
	return { matched, next: Math.max(0, ...matched.map((m) => m.n)) + 1 }
}

/** Whether FeeJuice has consumed the funding's message: its nullifier is siloed by FeeJuice. */
export async function isClaimed(
	node: { getNullifierMembershipWitness: (block: "latest", nullifier: Fr) => Promise<unknown> },
	f: Pick<Claimable, "key" | "secret">,
): Promise<boolean> {
	const inner = await computeFeeJuiceMessageNullifier(Fr.fromHexString(f.key), f.secret)
	const nullifier = await siloNullifier(AztecAddress.fromStringUnsafe(feeJuiceAddress), inner)
	return Boolean(await node.getNullifierMembershipWitness("latest", nullifier))
}

export interface FundingState {
	accountInitialized: boolean
	balance: bigint
	/** The fee limit of the next send: the account's own deploy while it is uninitialized, else the next contract. */
	nextFee: bigint
	/** The fee limit of the claim a new funding needs: the account's deploy, or a claim with no app call. */
	claimFee: bigint
	unclaimed: readonly Claimable[]
	/** Every authenticated funding so far, claimed or not. */
	funded: bigint
	fund?: bigint
	cap: bigint
	signer: Address
	funder: Address
	/** The signer's nonce at the scanned block, and its pending nonce now. */
	nonceAtScan: number
	nonceNow: number
}

export type FundingDecision = { kind: "claim"; fundings: readonly Claimable[] } | { kind: "none" } | { kind: "deposit"; amount: bigint }

export const fj = (wei: bigint): string => `${formatUnits(wei, 18)} AZTEC`

/** A positive Fee Juice amount in whole AZTEC with at most 18 decimals. */
export function parseFj(text: string, flag: string): bigint {
	if (!/^\d+(\.\d{1,18})?$/.test(text)) throw new Error(`${flag} takes an amount of AZTEC such as 120 or 12.5, not "${text}"`)
	const wei = parseUnits(text, 18)
	if (wei <= 0n) throw new Error(`${flag} must be positive`)
	return wei
}

/**
 * What a run does about Fee Juice before it deploys. An unclaimed funding is claimed and no other is made; a new one
 * is made only for a shortfall, and every refusal throws before anything is sent.
 */
export function decideFunding(s: FundingState): FundingDecision {
	if (s.unclaimed.length > 0) return { kind: "claim", fundings: s.unclaimed }
	if (s.accountInitialized && s.balance >= s.nextFee) return { kind: "none" }
	const shortfall = s.accountInitialized
		? `the balance ${fj(s.balance)} is below the next send's maximum fee ${fj(s.nextFee)}`
		: "the account is not deployed and holds no claimable funding"
	if (s.fund === undefined) throw new Error(`${shortfall}; re-run with --fund <AZTEC> — STOP`)
	if (!eq(s.signer, s.funder)) throw new Error(`signer ${s.signer} is not the pinned funding key ${s.funder} — STOP`)
	if (s.nonceAtScan !== s.nonceNow) {
		throw new Error(
			`the funding key has ${s.nonceNow - s.nonceAtScan} transaction(s) newer than the scanned block; wait a few minutes, then re-run — STOP`,
		)
	}
	// A claim whose fee limit outgrows it stalls every later run until fees fall, so it starts with twice the room.
	if (s.fund < 2n * s.claimFee) {
		throw new Error(`--fund ${fj(s.fund)} is below twice its own claim's maximum fee ${fj(s.claimFee)} — STOP`)
	}
	if (s.accountInitialized && s.balance + s.fund - s.claimFee < s.nextFee) {
		throw new Error(`--fund ${fj(s.fund)} leaves less than the next send's maximum fee ${fj(s.nextFee)} after its claim — STOP`)
	}
	if (s.funded + s.fund > s.cap) {
		throw new Error(`--fund ${fj(s.fund)} on top of ${fj(s.funded)} already funded exceeds --cap ${fj(s.cap)} — STOP`)
	}
	return { kind: "deposit", amount: s.fund }
}
