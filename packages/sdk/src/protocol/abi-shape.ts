/** An ABI parameter as solc emits it and the SDK's hand-written ABIs declare it. */
export interface AbiParam {
	name?: string
	type: string
	indexed?: boolean
	components?: readonly AbiParam[]
}

export interface AbiEntry {
	type: string
	name?: string
	stateMutability?: string
	anonymous?: boolean
	inputs?: readonly AbiParam[]
	outputs?: readonly AbiParam[]
}

const paramShape = (p: AbiParam): unknown => ({
	name: p.name ?? "",
	type: p.type,
	...(p.indexed !== undefined ? { indexed: p.indexed } : {}),
	...(p.components ? { components: p.components.map(paramShape) } : {}),
})

/** What a caller depends on: two entries of one shape select, encode and decode alike, named fields included. An
 *  event is non-anonymous unless it says otherwise. */
export const abiShape = (e: AbiEntry): string =>
	JSON.stringify({
		type: e.type,
		name: e.name,
		stateMutability: e.stateMutability,
		anonymous: e.type === "event" ? (e.anonymous ?? false) : undefined,
		inputs: (e.inputs ?? []).map(paramShape),
		outputs: (e.outputs ?? []).map(paramShape),
	})

/** The entries of `ours` that `theirs` has no entry of the same shape for, as `type name`. */
export function missingFrom(ours: readonly AbiEntry[], theirs: readonly AbiEntry[]): string[] {
	const shapes = new Set(theirs.map(abiShape))
	return ours.filter((e) => !shapes.has(abiShape(e))).map((e) => `${e.type} ${e.name ?? ""}`)
}
