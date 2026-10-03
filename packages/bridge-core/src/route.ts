/**
 * Builds the FIXED two-hop fuel route (token → WETH, unwrap, native-ETH → FeeJuice) from
 * config pool parameters. V4 orders a pool's currencies by address, and the router's
 * `_validateRoute` requires the WETH↔native discontinuity to sit on the FINAL boundary —
 * both invariants are encoded here once so call sites never hand-build hex.
 */
import type { Address } from "viem"
import type { PoolKey } from "./l1"

export interface FuelPoolParams {
	fee: number
	tickSpacing: number
}

export interface FuelRouteConfig {
	token: Address
	weth: Address
	feeJuice: Address
	tokenWeth: FuelPoolParams
	ethFj: FuelPoolParams
}

export interface FuelRoute {
	path: PoolKey[]
	zeroForOnes: boolean[]
}

const NATIVE = "0x0000000000000000000000000000000000000000" as Address

/** The two-hop route, address-sorted per pool, directions derived (never hardcoded). */
export function buildFuelRoute(cfg: FuelRouteConfig): FuelRoute {
	const token = cfg.token.toLowerCase()
	const weth = cfg.weth.toLowerCase()
	if (token === weth) throw new Error("buildFuelRoute: token and WETH are the same address")
	if (cfg.feeJuice.toLowerCase() === NATIVE) throw new Error("buildFuelRoute: feeJuice cannot be the native currency")

	const tokenIsCurrency0 = token < weth
	const hop1: PoolKey = {
		currency0: tokenIsCurrency0 ? cfg.token : cfg.weth,
		currency1: tokenIsCurrency0 ? cfg.weth : cfg.token,
		fee: cfg.tokenWeth.fee,
		tickSpacing: cfg.tokenWeth.tickSpacing,
		hooks: NATIVE,
	}
	// Native ETH is address(0) and therefore always currency0; ETH in ⇒ zeroForOne.
	const hop2: PoolKey = {
		currency0: NATIVE,
		currency1: cfg.feeJuice,
		fee: cfg.ethFj.fee,
		tickSpacing: cfg.ethFj.tickSpacing,
		hooks: NATIVE,
	}
	return { path: [hop1, hop2], zeroForOnes: [tokenIsCurrency0, true] }
}
