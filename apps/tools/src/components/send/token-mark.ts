import type { SelectableToken } from "@/lib/send-model"
import { safeDisplay } from "@/lib/token-display"

export interface Brand {
	readonly fill: string
	readonly ink: string
	readonly letters: string
}

const USDC: Brand = { fill: "#2775ca", ink: "#ffffff", letters: "US" }
const USDT: Brand = { fill: "#26a17b", ink: "#ffffff", letters: "UT" }
const WETH: Brand = { fill: "#627eea", ink: "#ffffff", letters: "WE" }
const WBTC: Brand = { fill: "#f09242", ink: "#ffffff", letters: "WB" }
const CBBTC: Brand = { fill: "#0052ff", ink: "#ffffff", letters: "CB" }

const BY_KEY: ReadonlyMap<string, Brand> = new Map([
	["1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", USDC],
	["1:0xdac17f958d2ee523a2206206994597c13d831ec7", USDT],
	["1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", WETH],
	["1:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", WBTC],
	["1:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", CBBTC],
])

const BY_MANIFEST_SYMBOL: ReadonlyMap<string, Brand> = new Map([
	["USDC", USDC],
	["USDT", USDT],
	["WETH", WETH],
	["WBTC", WBTC],
	["cbBTC", CBBTC],
])

export type MarkSubject = Pick<SelectableToken, "logoKey" | "symbol" | "source">

// A brand colour is granted only by identity this repository commits (an exact chain-and-address key,
// or a row of the bundled manifest), never by a symbol a list or a pasted contract merely claims.
export function markOf(t: MarkSubject): { brand: Brand | null; letters: string } {
	const brand = BY_KEY.get(t.logoKey.toLowerCase()) ?? (t.source === "manifest" ? BY_MANIFEST_SYMBOL.get(t.symbol) : undefined) ?? null
	if (brand) return { brand, letters: brand.letters }
	const letters = Array.from(safeDisplay(t.symbol).toUpperCase()).slice(0, 2).join("")
	return { brand: null, letters: letters || "??" }
}
