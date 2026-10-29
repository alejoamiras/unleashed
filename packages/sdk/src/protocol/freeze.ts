/** Freezes `value` and everything it holds, so a trust root parsed or pinned once cannot be edited after its check. */
export function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const inner of Object.values(value)) deepFreeze(inner)
	}
	return value
}
