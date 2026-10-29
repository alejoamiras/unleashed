import { refusal } from "./errors.ts"
import { deepFreeze } from "./protocol/freeze.ts"

/** Quotes this SDK made. A deposit signs the floors a quote carries, so it takes only one quoteFuel or quoteBridge
 *  computed: a quote edited, rebuilt from storage or written by hand could sign a floor no venue was held to. */
const made = new WeakSet<object>()

/** Vouches for `quote` and freezes it whole: a nested gas leg or registration edited after the fact would still pass. */
export function madeQuote<T extends object>(quote: T): T {
	made.add(deepFreeze(quote))
	return quote
}

export function assertQuote(quote: object): void {
	if (!made.has(quote)) throw refusal("invalid-request", "the quote was not made by quoteFuel or quoteBridge")
}
