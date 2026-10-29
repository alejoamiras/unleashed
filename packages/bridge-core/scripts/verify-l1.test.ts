import { type Hex, keccak256 } from "viem"
import { describe, expect, it } from "vitest"
import { START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR, type LifiChainBook } from "@unleashed/sdk/protocol"
import { judgeBook, type ObservedBook } from "./verify-l1"

describe("judgeBook", () => {
	const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const
	const codeOf = (n: number) => `0x60${n.toString(16).padStart(2, "0")}` as Hex
	const SELECTOR = "0x4666fc80"
	const BRIDGE = START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR
	const book: LifiChainBook = {
		chainId: 84532,
		diamond: at(1),
		executor: at(2),
		receiverAcrossV4: at(3),
		feeForwarder: at(4),
		facets: { [SELECTOR]: at(5), [BRIDGE]: at(8) },
		acrossSpokePool: at(6),
		codeHashes: { executor: keccak256(codeOf(2)), receiverAcrossV4: keccak256(codeOf(3)), feeForwarder: keccak256(codeOf(4)) },
	}
	const seen = (over: Partial<ObservedBook> = {}): ObservedBook => ({
		chainId: 84532,
		code: Object.fromEntries([1, 2, 3, 4, 6].map((n) => [at(n), codeOf(n)])),
		facets: { [SELECTOR]: at(5), [BRIDGE]: at(8) },
		...over,
	})
	const notOk = (o: ObservedBook) => judgeBook(book, o).flatMap((f) => (f.level === "ok" ? [] : [`${f.level} ${f.label}`]))

	it("passes the pinned book; fails a changed periphery, missing code, another chain or a moved bridge facet; warns on a moved swap facet", () => {
		expect(notOk(seen())).toEqual([])
		expect(notOk(seen({ code: { ...seen().code, [at(2)]: codeOf(9) } }))).toEqual([
			"fail LI.FI book (chain 84532) executor runtime code hash",
		])
		expect(notOk(seen({ code: { ...seen().code, [at(6)]: "0x" } }))).toEqual(["fail LI.FI book (chain 84532) code at acrossSpokePool"])
		expect(notOk(seen({ chainId: 11155111 }))).toEqual(["fail LI.FI book (chain 84532) chain id"])
		expect(notOk(seen({ facets: { [SELECTOR]: at(7), [BRIDGE]: at(8) } }))).toEqual([
			`warn LI.FI book (chain 84532) facet behind ${SELECTOR}`,
		])
		expect(notOk(seen({ facets: { [SELECTOR]: at(5), [BRIDGE]: at(7) } }))).toEqual([
			`fail LI.FI book (chain 84532) facet behind ${BRIDGE}`,
		])
	})
})
