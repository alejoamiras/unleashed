/** The protocol facts of a transfer record: what a claim or a recovery reads back. */

/**
 * The token a schema-3 record moves, copied from the factory's frozen registration record once the
 * L1 receipt exists (the pre-receipt copy is the app's prediction; the receipt rewrite is what the
 * L2 side is claimed against). `portal` here and `JournalBase.portal` are the same clone.
 */
export interface JournalTokenBlock {
	erc20: string
	portal: string
	l2Token: string
	nameWord: string
	symbolWord: string
	decimals: number
	displaySymbol: string
	/** From the factory's `PortalCreated`/`registrationOf` — the `register` leaf a first claim consumes. */
	registerKey?: string
	registerIndex?: string
}

/** The gas leg of a deposit. Amounts are base-unit decimal strings. */
export interface DepositFuelBlock {
	/** The slice of the deposit token swapped into Fee Juice on Ethereum. */
	amount: string
	/** Public gas only: the claim secret, bound to its recipient by the message. A private leg's derives from the
	 *  fuel salt, which travels in `DepositSecrets` alone. */
	secret?: string
	secretHashHex: string
	/** The floor signed into the deposit's witness. */
	minOutput: string
	leafIndex?: string
	messageHash?: string
	/** The Fee Juice the router's `Deposited` reports: the exact amount a claim consumes. */
	received?: string
	/** Private gas only: the PrivateFPC the Fee Juice was sent to. */
	fpc?: string
	/** Private gas only: an app's plaintext copy of the fuel salt, read when no sealed copy is passed. The SDK never
	 *  writes it. */
	bridgeSecretSalt?: string
	/** Latched before a wallet call that spends the message, with the time of the latest. */
	claimAttempt?: boolean
	claimAttemptAt?: number
	claimTxHash?: string
	/** Inclusion-grade: set only from an included receipt or a checkpointed nullifier. */
	consumed?: boolean
	/** Public gas only: a self-paid claim of its own landed the Fee Juice. */
	standaloneClaimed?: boolean
	/** Private gas only: the last claim was refused before any transaction existed, so the message is unspent and a
	 *  retry is safe; cleared once a hash lands. */
	setupInsufficiency?: boolean
}

interface DepositRecordBase {
	schema: 3
	/** The secret hash of the leg that names the deposit: the token leg's, or the gas leg's for gas only. */
	id: string
	direction: "deposit"
	isPrivate: boolean
	/** The token leg's claim amount, or the gas slice for gas only. Display only for a private deposit. */
	amount: string
	createdAt: number
	updatedAt: number
	completedAt?: number
	chainId: number
	/** The token's portal, or the Fee Juice portal for gas only. */
	portal: string
	/** The hub, or the L2 Fee Juice contract for gas only. */
	bridge: string
	recipient: string
	sender?: string
	/** Public token leg only: the claim secret. */
	secret?: string
	secretHashHex: string
	approveTxHash?: string
	depositTxHash?: string
	leafIndex?: string
	messageHash?: string
	claimTxHash?: string
	claimedByOther?: boolean
	depositL2Block?: number
	fuel?: DepositFuelBlock
	/** The hub had not registered the token when the deposit was sent: its first claim registers it. */
	registers?: true
	/** A private first claim's registration transaction. */
	registerTxHash?: string
}

/**
 * A deposit's protocol facts: everything a claim or a recovery reads back, under the names the app's records already
 * use, so an app record that extends this resumes with no migration.
 */
export type DepositRecord = DepositRecordBase &
	({ intent: "token" | "token+gas"; token: JournalTokenBlock } | { intent: "gas"; token?: never })
