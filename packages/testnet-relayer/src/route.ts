/** The one route the relayer serves: Base Sepolia's pinned Across pool into the bridge's routers on Sepolia. */
import { FILL_ROUTE, selfBuiltMaxDeposit } from "@unleashed/bridge-core/across-fill"
import { lifiBook } from "@unleashed/sdk/l1"
import { type Address, getAddress } from "viem"

export interface RelayerRoute {
	source: { chainId: number; spokePool: Address; token: Address }
	destination: {
		chainId: number
		spokePool: Address
		token: Address
		/** LI.FI's receiver: the app's every deposit pays it, and it runs the message. */
		recipient: Address
		/** The current router and the legacy ones a send in flight across a router switch may still name. */
		routers: readonly Address[]
	}
	/** The exclusive relayer the app names, and the account that fills. */
	filler: Address
	/** The most input a self-built send carries. */
	maxInput: bigint
}

/** The fields of a bridge manifest the route reads; `parseManifestV2` validates the whole file. */
export interface RouteManifest {
	network: string
	l1ChainId: number
	bridge: {
		l1: { depositRouter?: string | null; legacyRouters?: readonly string[] }
		routing?: {
			sources: readonly {
				chainId: number
				rail: string
				tokens: readonly { address: string; decimals: number; destToken: string }[]
			}[]
		} | null
	} | null
}

/**
 * The route `filler` serves from a testnet manifest: the source token and its Sepolia counterpart from the manifest's
 * Base Sepolia Across routing, the routers from its L1 block, the pools and the receiver from the LI.FI book.
 *
 * @throws unless the manifest is testnet on Sepolia with exactly one Base Sepolia Across token and a deposit router.
 */
export function testnetRoute(manifest: RouteManifest, filler: Address): RelayerRoute {
	if (manifest.network !== "testnet" || manifest.l1ChainId !== FILL_ROUTE.destination) {
		throw new Error(
			`the relayer serves the testnet on chain ${FILL_ROUTE.destination}, not ${manifest.network} on ${manifest.l1ChainId}`,
		)
	}
	const { depositRouter, legacyRouters = [] } = manifest.bridge?.l1 ?? {}
	const sources = manifest.bridge?.routing?.sources ?? []
	const source = sources.find((s) => s.chainId === FILL_ROUTE.source && s.rail === "acrossV4")
	if (!depositRouter || source?.tokens.length !== 1) {
		throw new Error(`the manifest routes no single Across token from chain ${FILL_ROUTE.source} into a deposit router`)
	}
	const [token] = source.tokens as [(typeof source.tokens)[number]]
	const dest = lifiBook(FILL_ROUTE.destination)
	return {
		source: { chainId: FILL_ROUTE.source, spokePool: lifiBook(FILL_ROUTE.source).acrossSpokePool, token: getAddress(token.address) },
		destination: {
			chainId: FILL_ROUTE.destination,
			spokePool: dest.acrossSpokePool,
			token: getAddress(token.destToken),
			recipient: dest.receiverAcrossV4,
			routers: [depositRouter, ...legacyRouters].map((a) => getAddress(a)),
		},
		filler: getAddress(filler),
		maxInput: selfBuiltMaxDeposit(token.decimals),
	}
}
