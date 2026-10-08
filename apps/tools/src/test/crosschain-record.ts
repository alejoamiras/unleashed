import type { CrossChainDepositRecord, CrossChainRoute } from "@unleashed/bridge-core"

const word = (byte: string) => `0x${byte.repeat(32)}` as `0x${string}`
const addr = (byte: string) => `0x${byte.repeat(20)}` as `0x${string}`

export const XC_SOURCE = 84532
export const XC_SENDER = `0x3fa8${"0".repeat(32)}c41d` as `0x${string}`
export const XC_SRC_TX = word("57")
export const XC_CREATED = 1_760_000_000_000
/** What the source receipt names once the rail has the send. */
export const XC_TRANSPORT = { kind: "across", originChainId: XC_SOURCE, depositId: "7", relayHash: word("7e") } as const

/** A public 5.00 USDC token+gas send from Base Sepolia on the Across rail, sent and bridging; each
 *  test sets the facts its state is about. */
export function xcRecord(over: Partial<CrossChainDepositRecord> = {}, route: Partial<CrossChainRoute> = {}): CrossChainDepositRecord {
	return {
		schema: 4,
		id: word("c1"),
		direction: "deposit",
		isPrivate: false,
		amount: "4410000",
		createdAt: XC_CREATED,
		updatedAt: XC_CREATED,
		chainId: 11155111,
		portal: addr("a1"),
		bridge: word("ab"),
		recipient: "0xaztec",
		secretHashHex: word("c1"),
		secret: word("5c"),
		sender: XC_SENDER,
		intent: "token+gas",
		token: {
			erc20: addr("e2"),
			portal: addr("a1"),
			l2Token: word("11"),
			nameWord: word("4e"),
			symbolWord: word("54"),
			decimals: 6,
			displaySymbol: "USDC",
		},
		fuel: { amount: "490000", secret: word("f4"), secretHashHex: word("e4"), minOutput: "450" },
		route: {
			provider: "lifi",
			rail: "acrossV4",
			srcChainId: XC_SOURCE,
			srcToken: addr("b5"),
			srcAmount: "5000000",
			srcSender: XC_SENDER,
			srcScanFromBlock: "31000000",
			srcTxHash: XC_SRC_TX,
			lifiTxId: word("71"),
			router: addr("d0"),
			minReceived: "4900000",
			maxPull: "4900000",
			scanFromBlock: "9300000",
			etaSeconds: 120,
			fillDeadline: XC_CREATED / 1000 + 7_200,
			...route,
		},
		...over,
	} as CrossChainDepositRecord
}
