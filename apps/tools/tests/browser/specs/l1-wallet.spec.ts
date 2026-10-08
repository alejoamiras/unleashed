/** The Ethereum side (cell 26): a refused signature, an account change, the wrong chain, a wallet that never answers. */
import { anvilKey, balanceOf, mint } from "@unleashed/bridge-core/sandbox"
import { TESTIDS } from "../../../src/lib/testids"
import { expect, test } from "../fixtures/test"
import { connectAztec, driveToConnected, tid } from "../pages/connect"
import { depositRecords } from "../pages/journal"
import { confirmReview, connectL1, openSend, reviewDeposit } from "../pages/send"

test.use({ family: "l1-wallet", cells: 5, l1Index: 7 })

const USDC = 10n ** 6n
const L1 = 31337

test("cell 26d — the wallet sends the deposit but the page never hears back: the reloaded row's CLAIM finds it on Ethereum and the claim lands", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const router = (sandbox.manifest.bridge?.l1.depositRouter ?? "") as `0x${string}`
	expect(router).not.toBe("")
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	const usdtL2 = await actor.l2TokenOf(usdt)
	const before = await balanceOf(usdtL2, actor.actor.address, "public")
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })

	// The router transaction (the deposit itself) is broadcast but its hash never reaches the page;
	// the Permit2 signature and the ERC-20 approval before it go through, so the record exists
	// with no deposit hash while the deposit sits confirmed on Ethereum.
	l1.swallowNext({ to: router })
	await confirmReview(page)
	await expect(page.locator(tid(TESTIDS.stepper))).toBeVisible({ timeout: 120_000 })
	await expect.poll(() => l1.holdsArmed(), { timeout: 120_000 }).toBe(0)
	expect(l1.permits().length).toBe(1)
	await expect.poll(async () => (await depositRecords(page)).length).toBe(1)
	expect((await depositRecords(page)).at(-1)?.depositTxHash).toBeUndefined()
	const transactionsBefore = l1.calls("eth_sendTransaction")

	await page.reload()
	await openSend(page)
	await connectL1(page)
	await driveToConnected(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.tabActivity)).click()
	const card = page.locator(tid(TESTIDS.journalCard)).first()
	await expect(card).toBeVisible()
	await expect(card).toHaveAttribute("data-stage", "depositing")
	await expect(card.locator(tid(TESTIDS.journalStage))).toContainText("look for it on Ethereum")
	await card.locator(tid(TESTIDS.journalClaim)).click()
	await expect.poll(async () => (await depositRecords(page)).at(-1)?.depositTxHash, { timeout: 120_000 }).toBeTruthy()
	await expect(card).toHaveAttribute("data-stage", "done", { timeout: 5 * 60_000 })
	expect(l1.calls("eth_sendTransaction"), "the found deposit was never sent again").toBe(transactionsBefore)
	const done = (await depositRecords(page)).at(-1)
	expect((await balanceOf(usdtL2, actor.actor.address, "public")) - before, "credited exactly once").toBe(BigInt(done?.amount ?? "0"))
})

test("cell 26e — the Ethereum wallet never answers the deposit: the reloaded row's CLAIM finds nothing on Ethereum, and Discard leaves no record", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	const router = (sandbox.manifest.bridge?.l1.depositRouter ?? "") as `0x${string}`
	expect(router).not.toBe("")
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })

	// The router transaction (the deposit itself) never answers; the Permit2 signature and the
	// ERC-20 approval before it go through, so the record exists with no deposit hash.
	l1.holdNext("transaction", { to: router })
	await confirmReview(page)
	await expect(page.locator(tid(TESTIDS.stepper))).toBeVisible({ timeout: 120_000 })
	await expect.poll(() => l1.holdsArmed(), { timeout: 120_000 }).toBe(0)
	expect(l1.permits().length).toBe(1)
	await expect.poll(async () => (await depositRecords(page)).length).toBe(1)
	expect((await depositRecords(page)).at(-1)?.depositTxHash).toBeUndefined()
	const signaturesBefore = l1.signatures
	const transactionsBefore = l1.calls("eth_sendTransaction")

	await page.reload()
	await openSend(page)
	await connectL1(page)
	await driveToConnected(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.tabActivity)).click()
	const card = page.locator(tid(TESTIDS.journalCard)).first()
	await expect(card).toBeVisible()
	await expect(card).toHaveAttribute("data-stage", "depositing")
	await expect(card.locator(tid(TESTIDS.journalStage))).toContainText("look for it on Ethereum")
	await card.locator(tid(TESTIDS.journalClaim)).click()
	await expect(card).toHaveAttribute("data-attention", "error", { timeout: 120_000 })
	await expect(card.locator(tid(TESTIDS.journalStep))).toContainText("No deposit for this record was found")
	expect((await depositRecords(page)).at(-1)?.depositTxHash).toBeUndefined()

	await card.locator(tid(TESTIDS.journalDiscard)).click()
	await card.locator(tid(TESTIDS.journalDiscardConfirm)).click()
	await expect(page.locator(tid(TESTIDS.journalCard))).toHaveCount(0)
	expect((await depositRecords(page)).length).toBe(0)
	expect(l1.signatures, "nothing was signed after the hold").toBe(signaturesBefore)
	expect(l1.calls("eth_sendTransaction"), "nothing was sent after the hold").toBe(transactionsBefore)
})

test("cell 26 — a refused signature ends the send on the review with the wallet's reason; nothing was sent", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })

	l1.rejectNext("signature")
	const confirm = page.locator(tid(TESTIDS.sendReviewConfirm))
	await expect(confirm).toBeEnabled({ timeout: 60_000 })
	await confirm.click()
	const error = page.locator(tid(TESTIDS.sendReviewError))
	await expect(error).toBeVisible({ timeout: 120_000 })
	await expect(error).toContainText(/rejected/i)
	await expect(page.locator(tid(TESTIDS.stepper))).toHaveCount(0)
	expect(l1.signatures, "the refusal was the only signature asked for").toBe(0)
	await expect(confirm, "the review stays live for another try").toBeEnabled()
})

test("cell 26 — the connected Ethereum account changes under the app: the chip follows", async ({ page, actor, l1 }) => {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	const chip = page.locator(tid(TESTIDS.l1Account))
	await expect(chip).toContainText(l1.address.slice(0, 6))

	await l1.setAccount(anvilKey(9))
	await expect(chip).toContainText(l1.address.slice(0, 6), { timeout: 30_000 })
	await expect(page.locator(tid(TESTIDS.l1Status))).toHaveAttribute("data-connected", "true")
})

test("cell 26 — the wrong Ethereum chain shows the switch, and the switch asks the wallet back", async ({ page, actor, l1 }) => {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	const switchBtn = page.locator(tid(TESTIDS.l1SwitchChain))
	await expect(switchBtn).toHaveCount(0)

	await l1.setChainId(1)
	await expect(switchBtn).toBeVisible({ timeout: 30_000 })
	await switchBtn.click()
	await expect(switchBtn).toHaveCount(0, { timeout: 30_000 })
	await expect(page.locator(tid(TESTIDS.l1Status))).toHaveAttribute("data-connected", "true")
})
