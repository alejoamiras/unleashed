import { describe, expect, it } from "vitest"
import type { TokenSource } from "@/lib/send-model"
import { markOf } from "./token-mark"

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
const FAKE = "0x6666666666666666666666666666666666666666"

const subject = (logoKey: string, symbol: string, source: TokenSource) => ({ logoKey, symbol, source })

describe("markOf", () => {
	it("brands an exact chain-1 key whatever its source, with the board letters", () => {
		expect(markOf(subject(`1:${USDC}`, "USDC", "list"))).toEqual({
			brand: { fill: "#2775ca", ink: "#ffffff", letters: "US" },
			letters: "US",
		})
		expect(markOf(subject("1:0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT", "pasted")).letters).toBe("UT")
	})

	it.each([31337, 11155111])("brands a manifest USDC on chain %i", (chainId) => {
		expect(markOf(subject(`${chainId}:${FAKE}`, "USDC", "manifest")).brand?.fill).toBe("#2775ca")
	})

	it.each<TokenSource>(["list", "pasted"])("never brands a %s token that only claims a manifest symbol", (source) => {
		expect(markOf(subject(`31337:${FAKE}`, "USDC", source))).toEqual({ brand: null, letters: "US" })
		expect(markOf(subject(`1:${FAKE}`, "USDC", source)).brand).toBeNull()
	})

	it.each(["EURC", "PXO"])("keeps a manifest %s grey", (symbol) => {
		expect(markOf(subject(`31337:${FAKE}`, symbol, "manifest")).brand).toBeNull()
	})

	it("draws grey letters from the sanitized symbol, or ?? when nothing is left", () => {
		expect(markOf(subject(`1:${FAKE}`, `z${String.fromCodePoint(0x202e)}kt`, "list")).letters).toBe("ZK")
		// Upper-casing can lengthen a letter (ß → SS); the mark still takes two.
		expect(markOf(subject(`1:${FAKE}`, "ßß", "list")).letters).toBe("SS")
		expect(markOf(subject(`1:${FAKE}`, String.fromCodePoint(0x200b), "pasted")).letters).toBe("??")
		expect(markOf(subject(`1:${FAKE}`, "", "pasted")).letters).toBe("??")
	})
})
