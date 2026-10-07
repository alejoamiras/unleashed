/** Tokens (cells 22, 23, 34, 37): the catalog, the paste lookup, the route verdicts, the L1 mint strip. */
import { balanceOf, freshToken, mint, mintPrivateGasNote, privateCreditOf, privateFpc } from "@unleashed/bridge-core/sandbox"
import { TESTIDS } from "../../../src/lib/testids"
import { expect, test } from "../fixtures/test"
import { connectAztec, tid } from "../pages/connect"
import { walletCeiling } from "../pages/fees"
import { depositRecords } from "../pages/journal"
import { confirmReview, connectL1, openSend, pasteToken, reviewDeposit, setVisibility, startDeposit, waitForReceipt } from "../pages/send"

test.use({ family: "tokens", cells: 4, l1Index: 2 })

const USDC = 10n ** 6n
const L1 = 31337
const ZERO = `0x${"00".repeat(20)}`
const NOT_A_CONTRACT = `0x${"33".repeat(20)}`

test("cell 34 — the catalog lists the generation's tokens first, then the community list; the paste lookup reads good and bad addresses", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.sendDirectionDeposit)).click()

	const keys = await page.locator(tid(TESTIDS.sendTokenTile)).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.key ?? ""))
	const manifestKeys = sandbox.manifest.bridge?.tokens.map((t) => `${L1}:${t.erc20.toLowerCase()}`) ?? []
	// The source chain's routed rows and each chain's native coin sit apart from Ethereum's catalog.
	const ethereumKeys = keys.filter((k) => k.startsWith(`${L1}:`))
	expect(ethereumKeys.slice(0, manifestKeys.length), "the generation's tokens lead Ethereum's rows, in manifest order").toEqual(
		manifestKeys,
	)
	// The community list is served from the suite's fixture (the egress fence answers its origin).
	expect(keys, "the fixture list's tokens follow").toEqual(expect.arrayContaining([`${L1}:0x1111111111111111111111111111111111111111`]))

	const lookup = page.locator(tid(TESTIDS.sendTokenLookup))
	await page.locator(tid(TESTIDS.sendTokenSearch)).fill(ZERO)
	await expect(lookup).toHaveAttribute("data-status", "error")
	await page.locator(tid(TESTIDS.sendTokenSearch)).fill(NOT_A_CONTRACT)
	await expect(lookup).toHaveAttribute("data-status", "error", { timeout: 30_000 })

	const erc20 = await freshToken(sandbox.clients.l1, { name: "Pasted", symbol: "PSTD", decimals: 6 }, [l1.address], 100n * USDC)
	await pasteToken(page, erc20)
	await expect(page.locator(tid(TESTIDS.sendStepAmount)), "adding selects the token").toBeVisible()
	await page.locator(tid(TESTIDS.sendAmountBack)).click()
	await expect(
		page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${L1}:${erc20.toLowerCase()}"]`),
		"and it stays in the list",
	).toBeVisible()
})

test("cell 37 — the mint strip mints a permissionless test token on Ethereum and the tile's balance follows", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { usdc } = sandbox.tokens
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.sendDirectionDeposit)).click()
	// The strip sits on the token step; the tile carries the Ethereum balance of the row.
	const tile = page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${L1}:${usdc.erc20.toLowerCase()}"]`)
	// The row's address has digits too, so the wait reads the balance itself.
	const balance = tile.locator(tid(TESTIDS.sendTokenBalance))
	await expect(balance).toContainText(/\d/)
	const before = (await balance.textContent()) ?? ""
	await page.locator(`${tid(TESTIDS.mintL1Card)} ${tid(TESTIDS.mintL1)}[data-symbol="${usdc.displaySymbol}"]`).click()
	await expect(page.locator(`${tid(TESTIDS.mintL1Status)}[data-error="true"]`)).toHaveCount(0)
	await expect.poll(async () => balance.textContent(), { timeout: 60_000 }).not.toBe(before)
	expect(l1.signatures, "the mint was one Ethereum transaction").toBe(1)
	// What the tile now says is what the amount step offers.
	await tile.click()
	await expect(page.locator(tid(TESTIDS.sendStepAmount))).toBeVisible()
	await expect(page.locator(tid(TESTIDS.sendBalanceL1))).toContainText(/\d/)
})

test("cell 22 — a routeless token greys the gas choices with the reason; the token alone still sends from credit", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const nort = sandbox.clients.deployment.tokens.nort
	await mint(sandbox.clients.l1, nort, l1.address, 10n * 10n ** 18n)
	const ceiling = await walletCeiling(actor, { isPrivate: false, registers: true })
	const fpc = await privateFpc(actor.s)
	await mintPrivateGasNote(actor.s, fpc, (ceiling * 14n) / 10n)
	const creditBefore = await privateCreditOf(actor.s, fpc)

	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await startDeposit(page, { l1ChainId: L1, erc20: nort, amount: "1", viaLookup: true })
	await setVisibility(page, false)
	await expect(page.locator(tid(TESTIDS.sendRouteStatus))).toHaveAttribute("data-route", "no-route", { timeout: 60_000 })
	await expect(page.locator(tid(TESTIDS.sendChoiceTokenGas))).toBeDisabled()
	await expect(page.locator(tid(TESTIDS.sendChoiceGas))).toBeDisabled()
	await expect(page.locator(tid(TESTIDS.sendChoiceToken))).toBeEnabled()

	await page.locator(tid(TESTIDS.sendAmountNext)).click()
	await expect(page.locator(tid(TESTIDS.sendStepReview))).toBeVisible()
	await confirmReview(page)
	await waitForReceipt(page)
	// The send read the token's block back from the factory; the harness derives the L2 token from it.
	const record = (await depositRecords(page)).at(-1)
	expect(record?.token?.erc20.toLowerCase(), "the record names the token").toBe(nort.toLowerCase())
	const nortL2 = await actor.s.l2TokenOf(record?.token as never)
	expect(await balanceOf(nortL2, actor.actor.address, "public"), "the whole token arrived, no slice taken").toBe(10n ** 18n)
	expect(await privateCreditOf(actor.s, fpc), "the credit paid exactly the register + claim ceiling").toBe(creditBefore - ceiling)
})

test("cell 23 — a discovered route is what the review shows: the hops and the slippage floor", async ({ page, sandbox, actor, l1 }) => {
	const { usdt } = sandbox.tokens
	await mint(sandbox.clients.l1, usdt.erc20 as `0x${string}`, l1.address, 200n * USDC)
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewDeposit(page, { l1ChainId: L1, erc20: usdt.erc20, amount: "100", intent: "token+gas", isPrivate: false })
	await page.locator(tid(TESTIDS.sendReviewDetailsToggle)).click()
	await expect(page.locator(tid(TESTIDS.sendReviewRoute))).toBeVisible()
	await expect(page.locator(tid(TESTIDS.sendReviewRoute))).not.toHaveText(/^\s*$/)
	await expect(page.locator(tid(TESTIDS.sendReviewSlippage))).toBeVisible()
})
