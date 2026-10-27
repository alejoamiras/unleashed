/**
 * LI.FI, Across, Stargate and LayerZero contracts the cross-chain routes touch, per chain. Third-party constants,
 * like Permit2: a manifest enables sources, it never names these. Sources, at lifinance/contracts
 * `65bae143b249a5fba3dd27d506e9e1d6d8538899` (the pinned forge lib): `deployments/<chain>.json` (Diamond, Executor,
 * receivers, the `FeeForwarder` li.quest's fee step calls), `deployments/<chain>.diamond.json` (the facet behind
 * each selector), `config/across.json` (SpokePool), `config/stargateV2.json` (TokenMessaging, EndpointV2). Read on
 * chain: each pool from `TokenMessaging.stargateImpls(assetId)` and its `token()`, each `EndpointV2.eid()`, and every
 * code hash. `lifi-addresses.test.ts` re-checks the book against the lib's files, and against the chains with
 * `LIFI_LIVE=1`.
 */
import { type Address, type Hex, zeroAddress, zeroHash } from "viem"
import { START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR } from "./across-v4"
import { SWAP_TOKENS_MULTIPLE_V3_SELECTOR, SWAP_TOKENS_SINGLE_V3_SELECTOR } from "./lifi-abi"
import { START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR, SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR } from "./stargate"

export interface StargatePool {
	readonly assetId: number
	readonly pool: Address
	readonly token: Address
}

/**
 * Runtime code hashes (`keccak256(eth_getCode)`, immutables included) of periphery that is neither a proxy nor
 * upgradeable, so a match proves the exact deployed contract.
 */
export interface LifiCodeHashes {
	readonly executor: Hex
	readonly receiverAcrossV4: Hex
	readonly receiverStargateV2?: Hex
	readonly feeForwarder: Hex
}

export interface LifiChainBook {
	readonly chainId: number
	readonly diamond: Address
	readonly executor: Address
	readonly receiverAcrossV4: Address
	/** Absent where LI.FI deploys no Stargate receiver. */
	readonly receiverStargateV2?: Address
	/** LI.FI's `FeeForwarder`: the `callTo` of the fee step li.quest prepends to a route. */
	readonly feeForwarder: Address
	/**
	 * The facet behind every Diamond selector this app accepts on this chain, and only those: a source route's
	 * entrypoint, or the fuel swap on the destination. A facet upgrade moves these; the live test notices.
	 */
	readonly facets: Readonly<Record<Hex, Address>>
	readonly acrossSpokePool: Address
	/** Absent where LI.FI has no Stargate V2 configuration. */
	readonly stargate?: { tokenMessaging: Address; pools: readonly StargatePool[] }
	readonly layerZero?: { endpointV2: Address; eid: number }
	readonly codeHashes: LifiCodeHashes
}

const DIAMOND: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"
const FEE_FORWARDER: Address = "0xCE40449B773a3E6E5e769ADb4e567179d4828cbd"
const ENDPOINT_V2: Address = "0x1a44076050125825900e736c501f859c50fE728c"
/** Same bytecode at the same address on every mainnet: the owner lives in storage. */
const FEE_FORWARDER_CODE_HASH: Hex = "0x7ee455a6853068874bfd201f93d6383ed6d88934a922316db5575b057e2ebe74"

function stargateFacets(facet: Address): Record<Hex, Address> {
	return { [SWAP_AND_START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR]: facet, [START_BRIDGE_TOKENS_VIA_STARGATE_SELECTOR]: facet }
}

const ETHEREUM: LifiChainBook = {
	chainId: 1,
	diamond: DIAMOND,
	executor: "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88",
	receiverAcrossV4: "0x07Cc0a0b41641D349240e1988169Fa11b31FC24E",
	receiverStargateV2: "0xB539B40793171211DCA8834da044fC14bCe64BDC",
	feeForwarder: FEE_FORWARDER,
	// GenericSwapFacetV3: the router's SWAP_TARGET on mainnet is this Diamond.
	facets: {
		[SWAP_TOKENS_SINGLE_V3_SELECTOR]: "0x8C9dBA771220Ed09580b77F0765e7153fbDE7790",
		[SWAP_TOKENS_MULTIPLE_V3_SELECTOR]: "0x8C9dBA771220Ed09580b77F0765e7153fbDE7790",
	},
	acrossSpokePool: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
	stargate: {
		tokenMessaging: "0x6d6620eFa72948C5f68A3C8646d58C00d3f4A980",
		pools: [{ assetId: 1, pool: "0xc026395860Db2d07ee33e05fE50ed7bD583189C7", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }],
	},
	layerZero: { endpointV2: ENDPOINT_V2, eid: 30101 },
	codeHashes: {
		executor: "0xf937f13890d789171f0bcf3c558a64869105000b6771dc182ddc165bde92ddfe",
		receiverAcrossV4: "0x95dcff4b5be9db943d9616d1c24b79c63f183041f28507b3b86f3e87be312269",
		receiverStargateV2: "0x535b6e74e5bbb38e9a469de60ff2587cf498b92a99be01f34d20c37a77e4cea2",
		feeForwarder: FEE_FORWARDER_CODE_HASH,
	},
}

const BASE: LifiChainBook = {
	chainId: 8453,
	diamond: DIAMOND,
	executor: "0x4DaC9d1769b9b304cb04741DCDEb2FC14aBdF110",
	receiverAcrossV4: "0x33b255b5db44A78c34381f89f1a454bc0Ef49871",
	receiverStargateV2: "0x1493e7B8d4DfADe0a178dAD9335470337A3a219A",
	feeForwarder: FEE_FORWARDER,
	facets: stargateFacets("0x6e378C84e657C57b2a8d183CFf30ee5CC8989b61"),
	acrossSpokePool: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
	stargate: {
		tokenMessaging: "0x5634c4a5FEd09819E3c46D86A965Dd9447d86e47",
		pools: [{ assetId: 1, pool: "0x27a16dc786820B16E5c9028b75B99F6f604b5d26", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
	},
	layerZero: { endpointV2: ENDPOINT_V2, eid: 30184 },
	codeHashes: {
		executor: "0xd462a248959d0a43d71ef3c7394e52fae2e3d46e4b16e01abec96e4029b0cd1b",
		receiverAcrossV4: "0xf587244c622cddb724cb7e24698cbb5b514069194e28e7f5d10edd72f27fa9a6",
		receiverStargateV2: "0xcc28fa92d456bbdbe566cb1a7e4e54f4288a11120632afffd340c70daf3e6ef9",
		feeForwarder: FEE_FORWARDER_CODE_HASH,
	},
}

const ARBITRUM: LifiChainBook = {
	chainId: 42161,
	diamond: DIAMOND,
	executor: "0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D",
	receiverAcrossV4: "0x33b255b5db44A78c34381f89f1a454bc0Ef49871",
	receiverStargateV2: "0x1493e7B8d4DfADe0a178dAD9335470337A3a219A",
	feeForwarder: FEE_FORWARDER,
	facets: stargateFacets("0x6e378C84e657C57b2a8d183CFf30ee5CC8989b61"),
	acrossSpokePool: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
	stargate: {
		tokenMessaging: "0x19cFCE47eD54a88614648DC3f19A5980097007dD",
		pools: [{ assetId: 1, pool: "0xe8CDF27AcD73a434D661C84887215F7598e7d0d3", token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" }],
	},
	layerZero: { endpointV2: ENDPOINT_V2, eid: 30110 },
	codeHashes: {
		executor: "0x60134c855342605905c28c4d6bb3d8bf04beff523cdf7e05028a345d8d0c9713",
		receiverAcrossV4: "0xe2a8b74a75bcd91bf9aa3e13f22ad05c1365e170258f028c9f7b5d223b634117",
		receiverStargateV2: "0x8cdb4ecacb924f0929baebec51ae34a13490ef33b2daf9684597bd1eaba04e81",
		feeForwarder: FEE_FORWARDER_CODE_HASH,
	},
}

const OPTIMISM: LifiChainBook = {
	chainId: 10,
	diamond: DIAMOND,
	executor: "0xC9E66aa9b08EB667e450e072E96F7086AD9f2c91",
	receiverAcrossV4: "0xe417AD5eb9e919567620A48B3757cc182cCdf9e4",
	receiverStargateV2: "0x556701899905f2f83AcA2977D3202Ee3a80f37b7",
	feeForwarder: FEE_FORWARDER,
	facets: stargateFacets("0xb6424d61c2c3930c91D93E33D0654f9412bFDD81"),
	acrossSpokePool: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
	stargate: {
		tokenMessaging: "0xF1fCb4CBd57B67d683972A59B6a7b1e2E8Bf27E6",
		pools: [{ assetId: 1, pool: "0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0", token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" }],
	},
	layerZero: { endpointV2: ENDPOINT_V2, eid: 30111 },
	codeHashes: {
		executor: "0xb2835985ac41f98c4583bb3ce0245fd156d065ffd7de6179f74ae0b1d66889a6",
		receiverAcrossV4: "0x1570b1f665f328cabd60ee494732409939ec2730ea987416d4c9091eed15bfb1",
		receiverStargateV2: "0x04bd9d032d7a839285267d12bca6393b9d652e7f84735cb09f1e3bf27b8ae813",
		feeForwarder: FEE_FORWARDER_CODE_HASH,
	},
}

/** The testnet destination. The fuel swap targets `TestnetFuelSwapper`, so no Diamond selector is accepted here. */
const SEPOLIA: LifiChainBook = {
	chainId: 11155111,
	diamond: "0xeCeC3970Ca674278DA8D9B1c484ACaF6B20181F5",
	executor: "0x7b01E6A2badAB05e2afaAeFf963f60B5FCF3a533",
	receiverAcrossV4: "0x51Cd54Fab6Bc72c4c313C7d2DD4E0bE1A4390f44",
	feeForwarder: "0xB0c62E0952A6388dA4f591B9b832B4234672A0Af",
	facets: {},
	acrossSpokePool: "0x5ef6C01E11889d86803e0B23e3cB3F9E9d97B662",
	codeHashes: {
		executor: "0xe830cbd72b65931a2fd9c8a207acd170bde6bc29c624a33598c59f2aeec324f6",
		receiverAcrossV4: "0x813834081995cad6d7ed8ed46cd3072006c4eb377efc9fa5a26e601aff2b41c5",
		feeForwarder: "0x5d2ba3e5c3ff525cbea8fc501d127defd587a168041254766eac7acfd1ad6a58",
	},
}

/** The testnet source: our own Across builder calls `AcrossFacetV4` here. */
const BASE_SEPOLIA: LifiChainBook = {
	chainId: 84532,
	diamond: "0x816Fc6EeE47e3157A666827a0C06205294C81770",
	executor: "0xa23f49d4eec23D58f5C000f51969AcEDe42a5E54",
	receiverAcrossV4: "0x0957F75A2b33f5088FCbE7C6A768fD0a8c2ce1F0",
	feeForwarder: "0xC7e003943dDAE973d7D6455ab54A22E18302aBeb",
	facets: { [START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR]: "0xed86e8F84072BC066A353a2180F38E5268F32B26" },
	acrossSpokePool: "0x82B564983aE7274c86695917BBf8C99ECb6F0F8F",
	codeHashes: {
		executor: "0x59521f65bfe6031588cadfbedb3fccdaa56df031edbb43b23be7e2a827807d32",
		receiverAcrossV4: "0xcc455dff67e4fe0b8e8659df86e65d6e42e887f628c2afa48f7f73bacf2709eb",
		feeForwarder: "0x903403bbf083178932fafaad9077af6bd279712cc2a3c7573c688033a4e05b1b",
	},
}

export const LIFI_BOOK: Readonly<Record<number, LifiChainBook>> = Object.freeze({
	1: ETHEREUM,
	8453: BASE,
	42161: ARBITRUM,
	10: OPTIMISM,
	11155111: SEPOLIA,
	84532: BASE_SEPOLIA,
})

/** The local sandbox's two anvils (Ethereum, then its source chain): chains no LI.FI deployment can exist on. */
export const SANDBOX_LIFI_CHAIN_IDS: readonly number[] = Object.freeze([31337, 31338])

/** The sandbox's stand-ins for LI.FI and Across: `SourceAcrossStub` as the source Diamond, LI.FI's compiled
 *  destination half on Ethereum, a `TestSpokePool` on each side. */
export interface SandboxLifiContracts {
	source: { chainId: number; diamond: Address; spokePool: Address }
	ethereum: { chainId: number; executor: Address; receiverAcrossV4: Address; spokePool: Address }
}

const NONE: Address = zeroAddress
const NO_CODE_HASHES: LifiCodeHashes = { executor: zeroHash, receiverAcrossV4: zeroHash, feeForwarder: zeroHash }
const sandboxBooks = new Map<number, LifiChainBook>()

/** What a sandbox does not deploy is the zero address, which every check that reads it refuses. */
function sandboxBooksOf(c: SandboxLifiContracts): LifiChainBook[] {
	const shared = { feeForwarder: NONE, codeHashes: NO_CODE_HASHES }
	return [
		{
			...shared,
			chainId: c.source.chainId,
			diamond: c.source.diamond,
			executor: NONE,
			receiverAcrossV4: NONE,
			facets: { [START_BRIDGE_TOKENS_VIA_ACROSS_V4_SELECTOR]: c.source.diamond },
			acrossSpokePool: c.source.spokePool,
		},
		{
			...shared,
			chainId: c.ethereum.chainId,
			diamond: NONE,
			executor: c.ethereum.executor,
			receiverAcrossV4: c.ethereum.receiverAcrossV4,
			facets: {},
			acrossSpokePool: c.ethereum.spokePool,
		},
	]
}

/**
 * Pins a local sandbox's own contracts as the books of its two anvils, so a local build routes, verifies and
 * watches a sandbox send through the same code as a live one. `LIFI_BOOK` itself never changes.
 *
 * @throws when either chain is outside `SANDBOX_LIFI_CHAIN_IDS`, so no live chain's book can be shadowed.
 */
export function registerSandboxLifi(c: SandboxLifiContracts): void {
	const books = sandboxBooksOf(c)
	for (const { chainId } of books) {
		if (!SANDBOX_LIFI_CHAIN_IDS.includes(chainId) || LIFI_BOOK[chainId]) {
			throw new Error(`lifi-addresses: chain ${chainId} is not a sandbox chain`)
		}
	}
	for (const book of books) sandboxBooks.set(book.chainId, Object.freeze(book))
}

/** The book for `chainId`; throws for a chain it does not cover, so no route reaches an unpinned chain. */
export function lifiBook(chainId: number): LifiChainBook {
	const book = LIFI_BOOK[chainId] ?? sandboxBooks.get(chainId)
	if (!book) throw new Error(`lifi-addresses: no LI.FI book for chain ${chainId}`)
	return book
}

/** The Stargate pool that bridges `token` from this chain, if the book has one. */
export function stargatePoolFor(book: LifiChainBook, token: Address): StargatePool | undefined {
	return book.stargate?.pools.find((p) => p.token.toLowerCase() === token.toLowerCase())
}
