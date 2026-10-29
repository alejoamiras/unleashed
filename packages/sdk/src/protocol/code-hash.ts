/**
 * Runtime code compared modulo what deployment writes and what the checkout leaks: immutables are written into the
 * runtime at deploy time, and solc's trailing CBOR metadata hashes the compiler input, absolute paths included. Every
 * other byte must match the build exactly.
 */
import { type Hex, keccak256 } from "viem"
import pins from "./code-pins.json" with { type: "json" }
import { deepFreeze } from "./freeze.ts"

export interface ImmutableSpan {
	start: number
	length: number
}

/**
 * A build's masked runtime: its length, where its metadata trailer starts, its immutables (each the spans of one
 * immutable's copies, which solc inlines wherever the code reads it), and the hash.
 */
export interface CodePin {
	length: number
	trailerStart: number
	immutables: ImmutableSpan[][]
	hash: Hex
}

export type PinnedContract = "DepositRouter" | "PortalFactory" | "TokenPortalImpl" | "FuelOnlyGate" | "TestnetFuelSwapper"

/** The pins of this release's contract builds, regenerated from the forge output by `scripts/code-pins.ts`. */
export const CODE_PINS = deepFreeze(pins) as Readonly<Record<PinnedContract, CodePin>>

/**
 * The size of solc's metadata trailer: a CBOR map and its 2-byte big-endian length. A sanity check on trusted
 * compiler output, not a parser: a declared length that leaves no code before it or does not land on a CBOR map
 * header throws.
 */
export function metadataTrailerSize(code: Uint8Array): number {
	const n = code.length
	const cborLength = n >= 2 ? ((code[n - 2] ?? 0) << 8) | (code[n - 1] ?? 0) : 0
	const size = cborLength + 2
	// Major type 5 (a map) is the top three bits 101.
	if (cborLength === 0 || size >= n || ((code[n - size] ?? 0) & 0xe0) !== 0xa0) {
		throw new Error(`the build's metadata trailer is malformed (declared length ${cborLength} in ${n} bytes)`)
	}
	return size
}

function maskedHash(code: Uint8Array, immutables: readonly (readonly ImmutableSpan[])[], trailerStart: number): Hex {
	const masked = Uint8Array.from(code)
	for (const s of immutables.flat()) masked.fill(0, s.start, s.start + s.length)
	return keccak256(masked.fill(0, trailerStart))
}

/** A build's pin. forge omits the immutable map for a contract with none; an empty map then masks nothing. */
export function pinOfBuild(built: Uint8Array, immutables: Record<string, ImmutableSpan[]> = {}): CodePin {
	const groups = Object.values(immutables)
		.map((copies) => [...copies].sort((a, b) => a.start - b.start))
		.sort((a, b) => (a[0]?.start ?? 0) - (b[0]?.start ?? 0))
	const trailerStart = built.length - metadataTrailerSize(built)
	return { length: built.length, trailerStart, immutables: groups, hash: maskedHash(built, groups, trailerStart) }
}

/** Whether every copy of each immutable holds the same bytes: a getter reads one copy, so a check through it binds
 *  the others only when they agree. */
function copiesAgree(code: Uint8Array, immutables: readonly (readonly ImmutableSpan[])[]): boolean {
	const bytes = (s: ImmutableSpan) => code.subarray(s.start, s.start + s.length).join(",")
	return immutables.every((copies) => copies.every((s) => bytes(s) === bytes(copies[0] as ImmutableSpan)))
}

/**
 * Deployed code under its build's mask, or undefined when the lengths differ or an immutable's copies disagree. Both
 * masks come from the build, so the result equals `pin.hash` exactly when the deployment differs from the build only
 * in its immutables, each written alike wherever it is read, and in its trailer.
 */
export function deployedHash(onChain: Uint8Array, pin: CodePin): Hex | undefined {
	if (onChain.length !== pin.length || !copiesAgree(onChain, pin.immutables)) return undefined
	return maskedHash(onChain, pin.immutables, pin.trailerStart)
}
