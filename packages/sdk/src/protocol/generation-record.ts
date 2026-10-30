/**
 * The committed record of the code a live bridge generation runs: each pinned L1 contract's address and masked runtime
 * pin, and the hub's address and class, taken from the artifacts the generation deployed and kept beside the record in
 * `contracts/bridge/generations/<network>/`. A live chain is checked against its record, never against what the current
 * sources build, so a source change leaves a running generation working until a new one is promoted with its record.
 * The record is a reviewed trust root: nothing at runtime fetches, selects or overrides it.
 */
import { type ContractArtifact, loadContractArtifact } from "@aztec-labs/aztec.js/abi"
import { getContractClassFromArtifact } from "@aztec-labs/aztec.js/contracts"
import { type Hex, hexToBytes, sha256 } from "viem"
import z from "zod"
import mainnetRecord from "../../../../contracts/bridge/generations/mainnet/record.json" with { type: "json" }
import testnetRecord from "../../../../contracts/bridge/generations/testnet/record.json" with { type: "json" }
import { CODE_PINS, type CodePin, type ImmutableSpan, metadataTrailerSize, type PinnedContract, pinOfBuild, samePin } from "./code-hash.ts"
import { deepFreeze } from "./freeze.ts"
import { SANDBOX_LIFI_CHAIN_IDS } from "./lifi-addresses.ts"
import type { ManifestV2 } from "./manifest-v2.ts"

const lowerAddress = z.string().regex(/^0x[0-9a-f]{40}$/, "expected a lower-case 20-byte 0x address")
const aztecAddress = z.string().regex(/^0x[0-9a-f]{64}$/, "expected a lower-case 32-byte 0x address")
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "expected a 64-hex sha256")

/** solc writes every immutable as one 32-byte word, and its CBOR trailer is 53 bytes today. */
const IMMUTABLE_BYTES = 32
export const MAX_TRAILER_BYTES = 64

/** The commit whose sources built an entry; a tag, when present, is the owner's tag that keeps that commit reachable. */
const buildSchema = z
	.object({ commit: z.string().regex(/^[0-9a-f]{40}$/, "expected a 40-hex commit"), tag: z.string().min(1).nullable() })
	.strict()

const spanSchema = z
	.object({
		start: z.number().int().nonnegative(),
		length: z
			.number()
			.int()
			.refine((n): boolean => n === IMMUTABLE_BYTES, "an immutable is one 32-byte word"),
	})
	.strict()

/** A mask a forged artifact could widen is bounded here: whole words before the trailer, none overlapping. */
const codePinSchema = z
	.object({
		length: z.number().int().positive(),
		trailerStart: z.number().int().positive(),
		immutables: z.array(z.array(spanSchema).min(1)),
		hash: z
			.string()
			.regex(/^0x[0-9a-f]{64}$/, "expected a 32-byte 0x hash")
			.transform((h) => h as Hex),
	})
	.strict()
	.superRefine((pin, ctx) => {
		const trailer = pin.length - pin.trailerStart
		if (trailer < 2 || trailer > MAX_TRAILER_BYTES)
			ctx.addIssue({ code: "custom", path: ["trailerStart"], message: `a ${trailer}-byte trailer is not solc's` })
		const spans = pin.immutables.flat().sort((a, b) => a.start - b.start)
		for (const [i, s] of spans.entries()) {
			const next = spans[i + 1]
			if (s.start + s.length > pin.trailerStart || (next && next.start < s.start + s.length))
				ctx.addIssue({ code: "custom", path: ["immutables"], message: `the span at ${s.start} overlaps another or the trailer` })
		}
	})

const evmEntrySchema = z.object({ address: lowerAddress, artifactSha256: sha256Hex, pin: codePinSchema, build: buildSchema }).strict()
const hubEntrySchema = z.object({ address: aztecAddress, classId: aztecAddress, artifactSha256: sha256Hex, build: buildSchema }).strict()

export const generationRecordSchema = z
	.object({
		schema: z.literal(1),
		network: z.string().min(1),
		l1ChainId: z.number().int().positive(),
		evm: z
			.object({
				DepositRouter: evmEntrySchema.optional(),
				PortalFactory: evmEntrySchema.optional(),
				TokenPortalImpl: evmEntrySchema.optional(),
				FuelOnlyGate: evmEntrySchema.optional(),
				TestnetFuelSwapper: evmEntrySchema.optional(),
			})
			.strict(),
		aztec: z.object({ TokenBridgeHub: hubEntrySchema }).strict().optional(),
	})
	.strict()

export type GenerationRecord = z.infer<typeof generationRecordSchema>
export type RecordBuild = z.infer<typeof buildSchema>
export type RecordedContract = z.infer<typeof evmEntrySchema>
export type RecordedHub = z.infer<typeof hubEntrySchema>

/** Parse-or-throw with path-annotated issues; the result is frozen. */
export function parseGenerationRecord(raw: unknown): GenerationRecord {
	const result = generationRecordSchema.safeParse(raw)
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
		throw new Error(`generation record failed strict validation — ${issues}`)
	}
	return deepFreeze(result.data)
}

/** A record directory's kept artifacts, relative to it: forge's layout for the L1 contracts, the exact Noir artifact. */
export const keptEvmArtifact = (contract: PinnedContract): string => `evm/${contract}.sol/${contract}.json`
export const KEPT_HUB_ARTIFACT = "aztec/TokenBridgeHub.json"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The contracts a manifest's route runs whose code is pinned, each at the address the manifest names. Mainnet's swap
 *  target is LI.FI's, not ours. */
export function pinnedContractsOf(m: ManifestV2): Array<[PinnedContract, string]> {
	const route = m.bridge?.l1 ?? m.fuelRoute
	if (!route) return []
	const factory = m.bridge ? m.bridge.l1.factory : m.fuelRoute?.gate
	return [
		...(route.depositRouter ? [["DepositRouter", route.depositRouter] as [PinnedContract, string]] : []),
		...(factory ? [[m.bridge ? "PortalFactory" : "FuelOnlyGate", factory] as [PinnedContract, string]] : []),
		...(m.bridge ? [["TokenPortalImpl", m.bridge.l1.implementation] as [PinnedContract, string]] : []),
		...(m.l1ChainId !== 1 && route.fuelSwapper ? [["TestnetFuelSwapper", route.fuelSwapper] as [PinnedContract, string]] : []),
	]
}

/**
 * Throws unless `record` is the record of `m`: the same network and chain, exactly the pinned contracts the manifest
 * names at the addresses it names them, and a hub exactly when the manifest has a bridge, at its address.
 */
export function assertRecordBinds(record: GenerationRecord, m: ManifestV2): void {
	if (record.network !== m.network || record.l1ChainId !== m.l1ChainId)
		throw new Error(
			`the ${record.network} record (chain ${record.l1ChainId}) is not the ${m.network} manifest's (chain ${m.l1ChainId})`,
		)
	const named = new Map(pinnedContractsOf(m))
	for (const [contract, address] of named) {
		const entry = record.evm[contract]
		if (!entry) throw new Error(`the ${record.network} record pins no ${contract}, which the manifest names at ${address}`)
		if (!same(entry.address, address)) throw new Error(`the ${record.network} record's ${contract} is ${entry.address}, not ${address}`)
	}
	const extra = Object.keys(record.evm).filter((c) => !named.has(c as PinnedContract))
	if (extra.length > 0) throw new Error(`the ${record.network} record pins ${extra.join(", ")}, which the manifest does not name`)
	const hub = record.aztec?.TokenBridgeHub
	if (!hub !== !m.bridge) throw new Error(`the ${record.network} record ${hub ? "has a hub the manifest lacks" : "has no hub"}`)
	if (hub && m.bridge && !same(hub.address, m.bridge.l2.hub.address))
		throw new Error(`the ${record.network} record's hub is ${hub.address}, not ${m.bridge.l2.hub.address}`)
}

/** Where a linear sweep finds PUSH32 operands; solc writes an immutable only into one. */
function push32Operands(code: Uint8Array, end: number): Set<number> {
	const operands = new Set<number>()
	for (let pc = 0; pc < end; ) {
		const op = code[pc] ?? 0
		if (op === 0x7f) operands.add(pc + 1)
		pc += op >= 0x60 && op <= 0x7f ? op - 0x5e : 1
	}
	return operands
}

/** Throws unless `pin` masks only what solc leaves open in `code`: each immutable a zero-filled PUSH32 operand (solc's
 *  placeholder), the trailer the build's CBOR metadata. A wider mask would let deployed code differ from the kept build
 *  where the build fixed it, a constant included. */
export function assertSolcShaped(pin: CodePin, code: Uint8Array): void {
	if (pin.length !== code.length) throw new Error(`the pin is ${pin.length} bytes, the build ${code.length}`)
	const trailer = metadataTrailerSize(code)
	if (pin.trailerStart !== code.length - trailer || trailer > MAX_TRAILER_BYTES)
		throw new Error(`the trailer at ${pin.trailerStart} is not the build's ${trailer}-byte CBOR metadata`)
	const operands = push32Operands(code, pin.trailerStart)
	const loose = pin.immutables.flat().filter((s: ImmutableSpan) => s.length !== IMMUTABLE_BYTES || !operands.has(s.start))
	if (loose.length > 0) throw new Error(`immutable span(s) at ${loose.map((s) => s.start).join(", ")} are not PUSH32 operands`)
	const fixed = pin.immutables.flat().filter((s) => code.subarray(s.start, s.start + s.length).some((b) => b !== 0))
	if (fixed.length > 0) throw new Error(`immutable span(s) at ${fixed.map((s) => s.start).join(", ")} are not zero in the build`)
}

interface KeptForgeArtifact {
	deployedBytecode?: { object?: `0x${string}`; immutableReferences?: Record<string, ImmutableSpan[]> }
}

const digestOf = (bytes: Uint8Array) => sha256(bytes).slice(2)

/**
 * Throws unless every entry derives from the kept artifact `read` returns for it: the file's sha256, the pin of its
 * runtime (solc-shaped), and the hub's class id. `read` takes a path relative to the record directory, so the working
 * tree, a git revision and in-memory buffers are checked alike.
 */
export async function assertRecordIntegrity(record: GenerationRecord, read: (relative: string) => Uint8Array): Promise<void> {
	for (const [contract, entry] of Object.entries(record.evm) as Array<[PinnedContract, RecordedContract]>) {
		const bytes = read(keptEvmArtifact(contract))
		if (digestOf(bytes) !== entry.artifactSha256) throw new Error(`${contract}: the kept artifact's sha256 is not the record's`)
		const runtime = (JSON.parse(new TextDecoder().decode(bytes)) as KeptForgeArtifact).deployedBytecode
		if (!runtime?.object || runtime.object === "0x") throw new Error(`${contract}: the kept artifact carries no runtime`)
		const code = hexToBytes(runtime.object)
		if (!samePin(pinOfBuild(code, runtime.immutableReferences), entry.pin))
			throw new Error(`${contract}: the pin is not its kept build's`)
		assertSolcShaped(entry.pin, code)
	}
	const hub = record.aztec?.TokenBridgeHub
	if (!hub) return
	const bytes = read(KEPT_HUB_ARTIFACT)
	if (digestOf(bytes) !== hub.artifactSha256) throw new Error("TokenBridgeHub: the kept artifact's sha256 is not the record's")
	const artifact = loadContractArtifact(JSON.parse(new TextDecoder().decode(bytes)))
	const classId = (await getContractClassFromArtifact(artifact)).id.toString()
	if (!same(classId, hub.classId))
		throw new Error(`TokenBridgeHub: the kept artifact's class ${classId} is not the record's ${hub.classId}`)
}

/** The pins a record holds, by contract; a contract the generation does not run has none. */
export function pinsOf(record: GenerationRecord): Readonly<Partial<Record<PinnedContract, CodePin>>> {
	return Object.fromEntries(Object.entries(record.evm).map(([c, e]) => [c, e.pin]))
}

/** The promoted generations' records, as reviewed in this release: one per live chain. */
export const LIVE_RECORDS: readonly GenerationRecord[] = Object.freeze([testnetRecord, mainnetRecord].map(parseGenerationRecord))

/** What a manifest's generation runs: the pins its L1 code is checked against and the hub artifact it deployed. */
export interface GenerationCode {
	pins: Readonly<Partial<Record<PinnedContract, CodePin>>>
	/** The live generation's record; absent on a sandbox chain, which runs this release's sources. */
	record?: GenerationRecord
	/** Megabytes, so loaded on first use. Throws for a generation with no hub. */
	hubArtifact(): Promise<ContractArtifact>
}

/** Each live generation's kept hub artifact, behind its own module. A record with a hub and no loader here fails. */
const LIVE_HUB_ARTIFACTS: Readonly<Record<string, () => Promise<ContractArtifact>>> = {
	testnet: async () => (await import("./hub-artifact-testnet.ts")).testnetHubArtifact,
}

const headHubArtifact = async (): Promise<ContractArtifact> => (await import("./artifacts.ts")).tokenBridgeHubArtifact

function liveHubArtifact(record: GenerationRecord): Promise<ContractArtifact> {
	const load = record.aztec ? LIVE_HUB_ARTIFACTS[record.network] : undefined
	if (!load) return Promise.reject(new Error(`the ${record.network} generation has no hub artifact in this release`))
	return load()
}

/**
 * The code `m`'s generation runs, selected by its L1 chain alone: a live chain's committed record, which must bind
 * `m`; a sandbox chain's own build (this release's pins and hub target). Throws for a live record `m` disagrees with
 * and for any other chain. No option, input or environment picks another record.
 */
export function codeOf(m: ManifestV2): GenerationCode {
	const record = LIVE_RECORDS.find((r) => r.l1ChainId === m.l1ChainId)
	if (record) {
		assertRecordBinds(record, m)
		return { pins: pinsOf(record), record, hubArtifact: () => liveHubArtifact(record) }
	}
	if (SANDBOX_LIFI_CHAIN_IDS.includes(m.l1ChainId)) return { pins: CODE_PINS, hubArtifact: headHubArtifact }
	throw new Error(`chain ${m.l1ChainId} has no committed generation record`)
}
