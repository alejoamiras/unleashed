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
