import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type Address, type Hex, zeroHash } from "viem"
import { describe, expect, it } from "vitest"
import { TESTNET_FILLER } from "./across-self-built"
import { acrossMessageOf, acrossRouteTx, bridgeFromCallerCall, crossChainIntent } from "./crosschain-route"
import { testnetSwapperFuelProvider, withFuelFloor } from "./fuel-quote"
import { type RouteExpectation, verifyRoute } from "./lifi-decode"
import { PRIVATE_FPC_ADDRESS } from "./private-fuel"

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "test", "fixtures", "lifi")
const rail = JSON.parse(readFileSync(join(FIXTURES, "testnet-rail.json"), "utf8"))

const RECIPIENT = `0x${"0a".repeat(32)}` as Hex
const TOKEN_HASH = `0x${"0b".repeat(32)}` as Hex
const FUEL_HASH = `0x${"0c".repeat(32)}` as Hex
const USDC = rail.destination.usdc as Address
const fuel = { secretHash: FUEL_HASH, slice: 400_000n, minOutput: 1n }

describe("crossChainIntent", () => {
	it("publishes the recipient only on a public token leg, and sends private gas to the PrivateFPC", () => {
		const pub = crossChainIntent(USDC, { isPrivate: false, recipient: RECIPIENT, tokenSecretHash: TOKEN_HASH, fuel })
		expect([pub.aztecRecipient, pub.fuelRecipient]).toEqual([RECIPIENT, RECIPIENT])
		const priv = crossChainIntent(USDC, { isPrivate: true, recipient: RECIPIENT, tokenSecretHash: TOKEN_HASH, fuel })
		expect([priv.aztecRecipient, priv.fuelRecipient.toLowerCase()]).toEqual([zeroHash, PRIVATE_FPC_ADDRESS.toLowerCase()])
		const gasOnly = crossChainIntent(USDC, { isPrivate: false, recipient: RECIPIENT, fuel })
		expect([gasOnly.aztecRecipient, gasOnly.tokenSecretHash, gasOnly.fuelRecipient]).toEqual([zeroHash, zeroHash, RECIPIENT])
		const plain = crossChainIntent(USDC, { isPrivate: false, recipient: RECIPIENT, tokenSecretHash: TOKEN_HASH })
		expect([plain.fuelSlice, plain.fuelRecipient, plain.fuelSecretHash, plain.minFuelOutput]).toEqual([0n, zeroHash, zeroHash, 0n])
		expect(() => crossChainIntent(USDC, { isPrivate: false, recipient: RECIPIENT })).toThrow(/token leg or a gas slice/)
	})
})

describe("an Across route of ours", () => {
	const lifiTxId = `0x${"11".repeat(32)}` as Hex
	const outputAmount = 4_900_000n
	const provider = testnetSwapperFuelProvider({
		reader: { quote: async (_, amountIn) => amountIn * 10n ** 12n },
		swapper: `0x${"5e".repeat(20)}`,
		router: rail.router.router,
		feeAsset: rail.router.feeAsset,
		transactionId: lifiTxId,
		slippageBps: 300,
		minFuelFj: 1n,
	})

	async function routeWith(venueSlice: bigint): Promise<RouteExpectation> {
		const q = await provider.quote(USDC, fuel.slice)
		const venue = await provider.quote(USDC, venueSlice)
		if (!q.ok || !venue.ok) throw new Error("the stub swapper quotes every amount")
		const intent = crossChainIntent(USDC, {
			isPrivate: false,
			recipient: RECIPIENT,
			tokenSecretHash: TOKEN_HASH,
			fuel: { ...fuel, minOutput: q.quote.minOut },
		})
		const swapData = withFuelFloor(venue.quote.swapData, q.quote.minOut)
		return {
			srcChainId: rail.source.chainId,
			user: rail.inputs.user,
			srcToken: rail.source.usdc,
			srcAmount: 5_000_000n,
			lifiTxId,
			l1ChainId: rail.destination.chainId,
			router: rail.router.router,
			destToken: USDC,
			feeAsset: rail.router.feeAsset,
			routerCall: bridgeFromCallerCall(intent, swapData, outputAmount, outputAmount),
			fuel: { provider: "testnetSwapper" },
			rail: { kind: "acrossV4", outputAmount, quoteTimestamp: 1_800_000_000, fillDeadline: 1_800_007_200 },
		}
	}

	it("verifies, carrying the message it was priced on; a venue that answers for another slice is refused", async () => {
		const x = await routeWith(fuel.slice)
		const verdict = verifyRoute(acrossRouteTx(x), x)
		expect(verdict.ok && verdict.decoded.across?.message).toBe(acrossMessageOf(x))
		const hostile = await routeWith(fuel.slice + 1n)
		const refused = verifyRoute(acrossRouteTx(hostile), hostile)
		expect(refused.ok ? undefined : refused.field).toBe("fuelSwap._swapData.fromAmount")
	})

	it("holds a deposit to the exclusive relayer it was built for, byte for byte", async () => {
		const open = await routeWith(fuel.slice)
		const held = { ...open, rail: { ...open.rail, exclusiveRelayer: TESTNET_FILLER } } as RouteExpectation
		expect(verifyRoute(acrossRouteTx(held), held).ok).toBe(true)
		const unheld = verifyRoute(acrossRouteTx(open), held)
		expect(unheld.ok ? undefined : unheld.field).toBe("call._acrossData.exclusiveRelayer")
	})
})
