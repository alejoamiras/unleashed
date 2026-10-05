import type { Address, Hex } from "viem"
import type { CrossChainDepositRecord, CrossChainRoute, JournalTokenBlock } from "../journal"

/** A 32-byte word of one repeated byte. */
export const word = (byte: string): Hex => `0x${byte.repeat(32)}`
/** A 20-byte address of one repeated byte. */
export const addr = (byte: string): Address => `0x${byte.repeat(20)}`

export const SOURCE_CHAIN = 84532

export const CROSSCHAIN_TOKEN: JournalTokenBlock = {
	erc20: addr("e2"),
	portal: addr("a1"),
	l2Token: word("11"),
	nameWord: `0x00${"4e".repeat(31)}`,
	symbolWord: `0x00${"54".repeat(31)}`,
	decimals: 6,
	displaySymbol: "USDC",
	registerKey: word("22"),
	registerIndex: "5",
}

/** A private token+gas send on the Across rail, journalled and signed on the source chain:
 *  `amount` is the floor `minReceived − fuelSlice` until the `Deposited` event rewrites it. */
export function crossChainRecord(
	over: Partial<CrossChainDepositRecord> = {},
	route: Partial<CrossChainRoute> = {},
): CrossChainDepositRecord {
	return {
		schema: 4,
		id: word("c1"),
		direction: "deposit",
		isPrivate: true,
		amount: "99000000",
		createdAt: 1,
		updatedAt: 1_760_000_000_000,
		chainId: 11155111,
		portal: addr("a1"),
		bridge: word("ab"),
		recipient: word("10"),
		secretHashHex: word("c1"),
		sealedEnvelope: "c2VhbGVk",
		sealerL1: addr("5e"),
		sender: addr("5e"),
		intent: "token+gas",
		token: CROSSCHAIN_TOKEN,
		fuel: { amount: "1000000", secret: word("f4"), secretHashHex: word("e4"), minOutput: "450" },
		route: {
			provider: "lifi",
			rail: "acrossV4",
			srcChainId: SOURCE_CHAIN,
			srcToken: addr("b5"),
			srcAmount: "100500000",
			srcSender: addr("5e"),
			srcScanFromBlock: "31000000",
			srcTxHash: word("57"),
			lifiTxId: word("71"),
			transport: { kind: "across", originChainId: SOURCE_CHAIN, depositId: "4242", relayHash: word("4e") },
			router: addr("d0"),
			minReceived: "100000000",
			maxPull: "100000000",
			scanFromBlock: "9300000",
			etaSeconds: 120,
			fillDeadline: 1_760_003_600,
			...route,
		},
		...over,
	} as CrossChainDepositRecord
}

/** The same send on the Stargate rail, settled as delivered to the user's wallet, with every
 *  optional route field set. */
export function stargateRecord(): CrossChainDepositRecord {
	return crossChainRecord(
		{ id: word("c2"), secretHashHex: word("c2"), completedAt: 3 },
		{
			rail: "stargateV2",
			srcBatchId: "0xbatch-1",
			transport: { kind: "stargate", guid: word("9a"), pool: addr("90") },
			maxPull: "101500000",
			fillDeadline: undefined,
			outcome: "delivered-to-wallet",
			outcomeTxHash: word("de"),
			outcomeAmount: "101090000",
			extraDeposits: [{ txHash: word("ee"), leafIndex: "8", amount: "5000000" }],
		},
	)
}
