/**
 * Durable artifacts for a bridge generation deploy: a write-ahead JOURNAL of the generation's steps
 * (the authoritative resume record) and an atomically-written CANDIDATE manifest.
 *
 * Why both: the deploy spans two chains and is not transactional, so every step is recorded the
 * moment it becomes irreversible and a re-run resumes from that record instead of re-deriving fresh
 * identities — the factory address, the hub salt and every pre-created portal are one generation.
 * The deploy writes a CANDIDATE, never the live manifest; promoting it is a separate, deliberate step.
 *
 * Durability: the journal is fsync'd after every append and the candidate is written to a same-dir
 * sibling temp (0600) + fsync + atomic rename(2); the parent dir is fsync'd after each mutation so
 * the rename/append survives a crash.
 */
import { randomBytes } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import z from "zod"
import { evmAddressV2, type ManifestV2, parseManifestV2 } from "../src/manifest-v2"

const aztecAddress = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex address")
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex word")
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex tx hash")
const decimalString = z.string().regex(/^\d+$/, "expected a base-10 integer string")

/**
 * One generation step. The two-line factory bracket is the write-ahead pair: the CREATE2 address is
 * journalled BEFORE the deploy tx, so a crash between broadcast and receipt still names the contract
 * the re-run must adopt rather than deploy a second one.
 */
export const deployStepSchema = z.discriminatedUnion("kind", [
	// The network the journal's addresses belong to, stamped before any of them exist.
	z
		.object({
			kind: z.literal("identity"),
			l1ChainId: z.number().int().nonnegative(),
			rollupVersion: z.number().int().nonnegative(),
			deployer: evmAddressV2,
			registry: evmAddressV2,
			feeJuicePortal: evmAddressV2,
		})
		.strict(),
	z.object({ kind: z.literal("classes-published"), tokenClassId: bytes32, hubClassId: bytes32 }).strict(),
	z.object({ kind: z.literal("factory-predicted"), factory: evmAddressV2, implementation: evmAddressV2 }).strict(),
	// No txHash when the factory was adopted after landing ahead of its journal entry.
	z
		.object({ kind: z.literal("factory-deployed"), factory: evmAddressV2, implementation: evmAddressV2, txHash: txHash.optional() })
		.strict(),
	z.object({ kind: z.literal("swap-target-deployed"), address: evmAddressV2, txHash }).strict(),
	z.object({ kind: z.literal("router-deployed"), router: evmAddressV2, txHash }).strict(),
	z.object({ kind: z.literal("hub-deployed"), hub: aztecAddress, salt: bytes32, txHash: txHash.optional() }).strict(),
	// `txHash` is the L1 createPortal; a portal that already existed has none (the call is idempotent).
	// `registerTxHash` is the L2 register_token, absent when the deploy leaves it to the first claim.
	z
		.object({
			kind: z.literal("token-precreated"),
			erc20: evmAddressV2,
			portal: evmAddressV2,
			txHash: txHash.optional(),
			registerTxHash: z.string().min(1).optional(),
		})
		.strict(),
	z.object({ kind: z.literal("pool-seeded"), erc20: evmAddressV2, txHash: txHash.optional() }).strict(),
	z.object({ kind: z.literal("calibrated"), fjPerTx: decimalString, fjRegister: decimalString }).strict(),
	z.object({ kind: z.literal("candidate-written"), path: z.string().min(1) }).strict(),
])

export type DeployStep = z.infer<typeof deployStepSchema>
export type DeployStepKind = DeployStep["kind"]
export type DeployIdentityStep = Extract<DeployStep, { kind: "identity" }>
export type DeployIdentity = Omit<DeployIdentityStep, "kind">

/** Every identity field, so a new one cannot be added to the type and forgotten by the comparison. */
const IDENTITY_FIELDS: readonly (keyof DeployIdentity)[] = ["l1ChainId", "rollupVersion", "deployer", "registry", "feeJuicePortal"]

const journalLineSchema = z.object({ ts: z.string().min(1), step: deployStepSchema }).strict()

/** fsync a directory so a create/rename/append is durable across a crash. */
function fsyncDir(dir: string): void {
	const dfd = openSync(dir, "r")
	try {
		fsyncSync(dfd)
	} finally {
		closeSync(dfd)
	}
}

/** Write JSON to a same-dir sibling temp (0600) + fsync + atomic rename + parent-dir fsync. The
 *  manifest is STRICT-validated first — a malformed candidate never reaches disk. */
export function writeCandidateAtomically(targetPath: string, manifest: ManifestV2): void {
	parseManifestV2(manifest)
	const dir = dirname(targetPath)
	const tmp = join(dir, `.${randomBytes(9).toString("hex")}.candidate.tmp`)
	const fd = openSync(tmp, "wx", 0o600)
	try {
		writeSync(fd, `${JSON.stringify(manifest, null, "\t")}\n`)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	renameSync(tmp, targetPath)
	fsyncDir(dir)
}

/** The candidate written so far, re-validated; `undefined` when the run has not written one yet. */
export function readCandidate(path: string): ManifestV2 | undefined {
	if (!existsSync(path)) return undefined
	return parseManifestV2(JSON.parse(readFileSync(path, "utf8")))
}

function parseEntry(line: string, n: number): DeployStep {
	let raw: unknown
	try {
		raw = JSON.parse(line)
	} catch {
		throw new Error(`deploy journal entry ${n} is not JSON — the journal is the resume authority and must not be hand-edited`)
	}
	const parsed = journalLineSchema.safeParse(raw)
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
		throw new Error(`deploy journal entry ${n} is not a valid step — ${issues}`)
	}
	return parsed.data.step
}

/** Every step recorded so far, oldest first. Throws on the first unreadable entry rather than
 *  resuming from a partial history — a step silently dropped here is a contract deployed twice. */
export function readDeployJournal(path: string): DeployStep[] {
	if (!existsSync(path)) return []
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line, i) => parseEntry(line, i + 1))
}

/** The per-token key of a step, for `has(kind, erc20)`. */
function stepKey(step: DeployStep): string | undefined {
	return "erc20" in step ? step.erc20.toLowerCase() : undefined
}

export interface DeployJournal {
	/** The recorded steps, oldest first; `append` extends this array in place. */
	readonly steps: DeployStep[]
	append(step: DeployStep): void
	/** Whether the step is already recorded — with `key` (an ERC-20) for the per-token kinds. */
	has(kind: DeployStepKind, key?: string): boolean
}

/**
 * Binds the journal to one network. A generation's recorded addresses only exist on the chain that
 * deployed them, so resuming against another one would adopt a stranger's factory and hub as this
 * generation's — the stamp turns that into a refusal before the first step reads anything.
 */
function stampIdentity(journal: DeployJournal, identity: DeployIdentity): void {
	const recorded = journal.steps.find((s): s is DeployIdentityStep => s.kind === "identity")
	if (!recorded) {
		if (journal.steps.length > 0) {
			throw new Error("deploy journal predates identity stamping — its steps name a network nothing here can verify; start a new one")
		}
		journal.append({ kind: "identity", ...identity })
		return
	}
	for (const field of IDENTITY_FIELDS) {
		const was = String(recorded[field]).toLowerCase()
		const now = String(identity[field]).toLowerCase()
		if (was !== now) throw new Error(`deploy journal ${field} is ${was}, the live network says ${now} — wrong network; STOP`)
	}
}

/** Passing `identity` stamps an empty journal with it and refuses one recorded on another network. */
export function openDeployJournal(path: string, identity?: DeployIdentity): DeployJournal {
	// A fresh checkout has no journal dir; the first append would otherwise fail on ENOENT.
	mkdirSync(dirname(path), { recursive: true })
	const steps = readDeployJournal(path)
	const journal: DeployJournal = {
		steps,
		append(step: DeployStep): void {
			const fd = openSync(path, "a", 0o600)
			try {
				writeSync(fd, `${JSON.stringify({ ts: new Date().toISOString(), step })}\n`)
				fsyncSync(fd)
			} finally {
				closeSync(fd)
			}
			fsyncDir(dirname(path))
			steps.push(step)
		},
		has: (kind, key) => steps.some((s) => s.kind === kind && (key === undefined || stepKey(s) === key.toLowerCase())),
	}
	if (identity) stampIdentity(journal, identity)
	return journal
}
