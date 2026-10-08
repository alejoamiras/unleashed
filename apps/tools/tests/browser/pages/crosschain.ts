/** A deposit that starts on another chain, testid-only: its review signed on the source chain, the record it files, and
 *  that record's card. */
import { expect, type Page } from "@playwright/test"
import { CROSSCHAIN_JOURNAL_KEY } from "@unleashed/bridge-core"
import { TESTIDS } from "../../../src/lib/testids"
import { tid } from "./connect"
import { confirmReview, type Intent, reviewDeposit } from "./send"

export interface CrossChainPlan {
	srcChainId: number
	srcToken: string
	/** Decimal string as a user types it. */
	amount: string
	intent: Intent
	isPrivate: boolean
}

/** The schema-4 fields a cell reads back; the chain is the authority for everything else. */
export interface CrossChainRecord {
	id: string
	isPrivate: boolean
	amount: string
	leafIndex?: string
	approveTxHash?: string
	depositTxHash?: string
	claimTxHash?: string
	completedAt?: number
	fuel?: { amount: string; received?: string }
	route: {
		srcTxHash?: string
		srcBatchId?: string
		lifiTxId: string
		minReceived: string
		fillDeadline?: number
		terms?: string
		transport?: { kind: string; relayHash?: string }
		outcome?: string
		outcomeAmount?: string
		extraDeposits?: { txHash: string; leafIndex: string; amount: string }[]
	}
}

/** Token row on the source chain → amount → choice → visibility → the cross-chain review. */
export async function reviewCrossChain(page: Page, plan: CrossChainPlan): Promise<void> {
	const { srcChainId: l1ChainId, srcToken: erc20, ...rest } = plan
	await reviewDeposit(page, { l1ChainId, erc20, ...rest }, TESTIDS.sendXcReview)
}

/** The review asks the wallet onto the source chain, then signs there; resolves once the stepper takes over. */
export async function signOnSource(page: Page, srcChainId: number): Promise<void> {
	const notice = page.locator(tid(TESTIDS.sendWrongChain))
	await expect(notice).toHaveAttribute("data-need", String(srcChainId))
	await notice.locator(tid(TESTIDS.sendWrongChainSwitch)).click()
	await expect(notice).toHaveCount(0)
	await confirmReview(page)
}

/** Every schema-4 record the page's journal holds, newest last. */
export async function crossChainRecords(page: Page): Promise<CrossChainRecord[]> {
	const raw = await page.evaluate((key) => localStorage.getItem(key), CROSSCHAIN_JOURNAL_KEY)
	return raw ? (JSON.parse(raw) as { records: CrossChainRecord[] }).records : []
}

/** The newest record, once `ready` holds for it. */
export async function crossChainRecordWhen(
	page: Page,
	ready: (r: CrossChainRecord) => boolean,
	what: string,
	timeout = 180_000,
): Promise<CrossChainRecord> {
	let last: CrossChainRecord | undefined
	await expect
		.poll(
			async () => {
				last = (await crossChainRecords(page)).at(-1)
				return last !== undefined && ready(last)
			},
			{ message: what, timeout },
		)
		.toBe(true)
	return last as CrossChainRecord
}

/** The Activity tab's card for `id`. */
export async function crossChainCard(page: Page, id: string) {
	await page.locator(tid(TESTIDS.tabActivity)).click()
	const card = page.locator(`${tid(TESTIDS.journalCard)}[data-id="${id}"]`)
	await expect(card).toBeVisible()
	return card
}

/** The phase the card's cross-chain body names (`bridging`, `delivered`, `expired`, …); waits until it says `kind`. */
export async function expectCardPhase(page: Page, id: string, kind: string, timeout = 240_000): Promise<void> {
	const card = await crossChainCard(page, id)
	await expect(card.locator(tid(TESTIDS.journalXcOutcome))).toHaveAttribute("data-phase", kind, { timeout })
}
