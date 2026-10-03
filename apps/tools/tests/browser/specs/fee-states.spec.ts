/**
 * Fee states (cells 7–12): what the account holds decides whether the token alone may be chosen,
 * and the confirm re-reads it. Every stop is the wizard's own copy, on screen before any signature.
 */
import { PRIVATE_FPC_ADDRESS } from "@unleashed/bridge-core"
import { fundPublicFeeJuice, mint, mintPrivateGasNote, privateFpc } from "@unleashed/bridge-core/sandbox"
import { TESTIDS } from "../../../src/lib/testids"
import { type ActorHandle, expect, test } from "../fixtures/test"
import { connectAztec, tid, walletFrame } from "../pages/connect"
import { walletCeiling } from "../pages/fees"
import { connectL1, openSend, reviewDeposit, setVisibility, startDeposit } from "../pages/send"

test.use({ family: "fee-states", cells: 6, l1Index: 3 })

const USDC = 10n ** 6n
const L1 = 31337

const ceilingOf = (actor: ActorHandle, isPrivate: boolean): Promise<bigint> => walletCeiling(actor, { isPrivate, registers: false })

/** The token-only card is greyed, its reason in place of its caption and named by its `aria-describedby`. */
async function expectTokenOnlyBlocked(page: import("@playwright/test").Page, copy: RegExp): Promise<void> {
	const card = page.locator(tid(TESTIDS.sendChoiceToken))
	await expect(card).toBeDisabled({ timeout: 60_000 })
	const reasonId = await card.getAttribute("aria-describedby")
	expect(reasonId, "the disabled card names its reason").toBeTruthy()
	await expect(page.locator(`#${reasonId}`)).toHaveText(copy)
	await expect(page.locator(tid(TESTIDS.sendChoiceTokenGas))).toHaveAttribute("aria-checked", "true")
}

async function toAmountStep(
	page: import("@playwright/test").Page,
	actor: ActorHandle,
	erc20: string,
	profile: "plain" | "selfpay",
	isPrivate = false,
) {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile, account: actor.address })
	await startDeposit(page, { l1ChainId: L1, erc20, amount: "10" })
	await setVisibility(page, isPrivate)
}

test("cell 7 — plain, nothing held: the token alone is blocked as `none`", async ({ page, sandbox, actor, l1 }) => {
	const { usdc } = sandbox.tokens
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	await toAmountStep(page, actor, usdc.erc20, "plain")
	await expectTokenOnlyBlocked(page, /holds no gas the bridge can claim with/)
})

test("cell 8 — selfpay, only public FJ, under the ceiling: `short`", async ({ page, sandbox, actor, l1 }) => {
	const { usdc } = sandbox.tokens
	await fundPublicFeeJuice(actor.s, (await ceilingOf(actor, false)) / 2n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	await toAmountStep(page, actor, usdc.erc20, "selfpay")
	await expectTokenOnlyBlocked(page, /gas is under what this claim sets aside/)
})

test("cell 9 — plain, only credit, under the ceiling: `short`", async ({ page, sandbox, actor, l1 }) => {
	const { usdc } = sandbox.tokens
	await mintPrivateGasNote(actor.s, await privateFpc(actor.s), (await ceilingOf(actor, false)) / 2n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	await toAmountStep(page, actor, usdc.erc20, "plain")
	await expectTokenOnlyBlocked(page, /gas is under what this claim sets aside/)
})

test("cell 10 — selfpay, private, only public FJ: a private claim never pays from it, so `none`", async ({ page, sandbox, actor, l1 }) => {
	const { usdc } = sandbox.tokens
	await fundPublicFeeJuice(actor.s, (await ceilingOf(actor, true)) * 3n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	await toAmountStep(page, actor, usdc.erc20, "selfpay", false)
	// Public first: the held public Fee Juice opens the token alone; the private toggle closes it.
	await expect(page.locator(tid(TESTIDS.sendChoiceToken))).toBeEnabled({ timeout: 60_000 })
	await setVisibility(page, true)
	await expectTokenOnlyBlocked(
		page,
		/A private bridge claims only with private gas, and your Aztec account holds no gas at the fee contract/,
	)
})

test("cell 11 — plain, private, credit under the ceiling: private `short`", async ({ page, sandbox, actor, l1 }) => {
	const { usdc } = sandbox.tokens
	await mintPrivateGasNote(actor.s, await privateFpc(actor.s), (await ceilingOf(actor, true)) / 2n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)
	await toAmountStep(page, actor, usdc.erc20, "plain", true)
	await expectTokenOnlyBlocked(page, /A private bridge claims only with private gas, and yours is under what this claim sets aside/)
})

test("cell 12 — plain, the confirm's gas re-read fails: `unverifiable` stands the review down, nothing signed", async ({
	page,
	run,
	sandbox,
	actor,
	l1,
}) => {
	const { usdc } = sandbox.tokens
	const ceiling = await ceilingOf(actor, false)
	await mintPrivateGasNote(actor.s, await privateFpc(actor.s), (ceiling * 14n) / 10n)
	await mint(sandbox.clients.l1, usdc.erc20 as `0x${string}`, l1.address, 100n * USDC)

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdc.erc20, amount: "10", intent: "token", isPrivate: false })
	// The confirm re-reads the credit at the FPC; that one read is made to fail.
	await walletFrame(page, run, "plain").evaluate(
		(fpc) => window.__unleashedTestWallet!.failNext("executeUtility", fpc, "node read aborted"),
		PRIVATE_FPC_ADDRESS.toLowerCase(),
	)
	const confirm = page.locator(tid(TESTIDS.sendReviewConfirm))
	await expect(confirm).toBeEnabled({ timeout: 60_000 })
	await confirm.click()
	const stale = page.locator(tid(TESTIDS.sendReviewStale))
	await expect(stale).toBeVisible({ timeout: 60_000 })
	await expect(stale).toContainText("could not be read just now")
	await expect(page.locator(tid(TESTIDS.stepper))).toHaveCount(0)
	expect(l1.signatures, "nothing was signed on Ethereum").toBe(0)
})
