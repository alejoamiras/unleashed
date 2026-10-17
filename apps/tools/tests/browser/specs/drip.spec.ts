/** The Drip tab (cells 35, 36, 38, 47): faucet drips land on the selected account, add-to-wallet fails
 *  open, and the AZTEC card mints on Ethereum. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FeeAssetHandlerAbi } from "@aztec-foundation/l1-artifacts"
import { balanceOf, type DripDeploymentRecord, erc20BalanceOf, registerDripFixture } from "@unleashed/bridge-core/sandbox"
import { formatBigInt } from "../../../src/lib/format"
import { TESTIDS } from "../../../src/lib/testids"
import { expect, test } from "../fixtures/test"
import { connectAztec, tid } from "../pages/connect"
import { balancesShown, drip } from "../pages/drip"

test.use({ family: "drip", cells: 5, l1Index: 6 })

const L1 = 31337

async function signalToken(run: { artifactsDir: string }, wallet: unknown) {
	const record = JSON.parse(readFileSync(join(run.artifactsDir, "deployments.json"), "utf8")) as DripDeploymentRecord
	const { tokens } = await registerDripFixture(wallet as never, record)
	const signal = tokens.get("SIGNAL")
	if (!signal) throw new Error("the drip fixture has no SIGNAL token")
	return signal
}

test("cell 38 — public and private drips land, and the card's balances follow the chain", async ({ page, run, sandbox, actor }) => {
	const signal = await signalToken(run, sandbox.clients.l2.wallet)
	await page.goto("/")
	await connectAztec(page, { profile: "plain", account: actor.address })

	await drip(page, "SIGNAL", "public")
	const pub = await balanceOf(signal, actor.actor.address, "public")
	expect(pub).toBeGreaterThan(0n)
	await expect.poll(async () => (await balancesShown(page, "SIGNAL")).publicText, { timeout: 30_000 }).not.toMatch(/^\s*0(\.0+)?\s*$/)

	await drip(page, "SIGNAL", "private")
	expect(await balanceOf(signal, actor.actor.address, "private")).toBeGreaterThan(0n)
	expect(await balanceOf(signal, actor.actor.address, "public"), "a private drip leaves the public balance alone").toBe(pub)
	await expect.poll(async () => (await balancesShown(page, "SIGNAL")).privateText, { timeout: 30_000 }).not.toMatch(/^\s*0(\.0+)?\s*$/)
})

test("cell 35 — add-to-wallet on a plain wallet: the transport's unknown method fails open as `unsupported`", async ({ page, actor }) => {
	await page.goto("/")
	await connectAztec(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.tabDrip)).click()
	const card = page.locator(`${tid(TESTIDS.tokenCard)}[data-symbol="SIGNAL"]`)
	await card.locator(tid(TESTIDS.btnAddToWallet)).click()
	await expect(card.locator(tid(TESTIDS.btnAddToWallet))).toHaveAttribute("data-add-status", "unsupported", { timeout: 30_000 })
})

test("cell 35 — add-to-wallet on selfpay: the wallet's explicit refusal fails open as `unsupported`", async ({ page, actor }) => {
	await page.goto("/")
	await connectAztec(page, { profile: "selfpay", account: actor.address })
	await page.locator(tid(TESTIDS.tabDrip)).click()
	const card = page.locator(`${tid(TESTIDS.tokenCard)}[data-symbol="SIGNAL"]`)
	await card.locator(tid(TESTIDS.btnAddToWallet)).click()
	await expect(card.locator(tid(TESTIDS.btnAddToWallet))).toHaveAttribute("data-add-status", "unsupported", { timeout: 30_000 })
})

test("cell 36 — add-to-wallet on full: `ok`, and the card no longer offers it", async ({ page, actor }) => {
	await page.goto("/")
	await connectAztec(page, { profile: "full", account: actor.address })
	await page.locator(tid(TESTIDS.tabDrip)).click()
	const card = page.locator(`${tid(TESTIDS.tokenCard)}[data-symbol="SIGNAL"]`)
	const add = card.locator(tid(TESTIDS.btnAddToWallet))
	await add.click()
	// A token the wallet reports registered loses its button — the card offers nothing more to add.
	await expect(add).toHaveCount(0, { timeout: 30_000 })
})

test("cell 47 — the AZTEC card connects Ethereum from the Drip tab and mints with one signature; Send's AZTEC tile follows", async ({
	page,
	sandbox,
	actor,
	l1,
}) => {
	const { feeJuice: feeAsset, feeAssetHandler: handler } = sandbox.clients.deployment
	if (!handler) throw new Error("the local network reported no fee asset handler, so the build has no AZTEC mint")
	const perCall = await sandbox.clients.l1.pub.readContract({
		address: handler,
		abi: FeeAssetHandlerAbi,
		functionName: "mintAmount",
		args: [],
	})
	const whole = formatBigInt(perCall, 18, 0)

	await page.goto("/")
	await connectAztec(page, { profile: "plain", account: actor.address })
	await page.locator(tid(TESTIDS.tabDrip)).click()
	const card = page.locator(tid(TESTIDS.dripFeeAssetCard))
	const button = card.locator(tid(TESTIDS.dripFeeAssetMint))
	await expect(button).toHaveAttribute("data-action", "connect")
	await button.click()
	await expect(button).toHaveAttribute("data-action", "mint")
	await expect(button).toHaveText("Get AZTEC")
	await expect(button).toHaveAttribute("aria-label", `Get ${whole} AZTEC into your Ethereum wallet`)

	// The Drip cards' balance reads keep the wallet frame raised over the rail, so the tab switches are forced.
	const sendTab = async () => {
		await page.locator(tid(TESTIDS.tabSend)).dispatchEvent("click")
		await expect(page.locator(tid(TESTIDS.sendView))).toBeVisible()
	}
	// Send's token step is already showing when the mint lands on the other tab: the tile must follow it there.
	await sendTab()
	await page.locator(tid(TESTIDS.sendDirectionDeposit)).click()
	const balance = page.locator(`${tid(TESTIDS.sendTokenTile)}[data-key="${L1}:${feeAsset}"] ${tid(TESTIDS.sendTokenBalance)}`)
	const before = await erc20BalanceOf(sandbox.clients.l1, feeAsset, l1.address)
	await expect(balance).toHaveText(formatBigInt(before, 18))

	await page.locator(tid(TESTIDS.tabDrip)).dispatchEvent("click")
	await button.click()
	const status = card.locator(tid(TESTIDS.dripFeeAssetStatus))
	await expect(status).toHaveAttribute("data-drip-status", "ok", { timeout: 60_000 })
	await expect(status).toContainText(`Sent ${whole} AZTEC to your Ethereum wallet`)
	await expect(status.locator(tid(TESTIDS.dripTxLink))).toHaveAttribute("href", /\/tx\/0x[0-9a-f]{64}$/)
	await expect(page.locator(tid(TESTIDS.toast)).filter({ hasText: `Dripped ${whole} AZTEC to your Ethereum wallet` })).toBeVisible()
	expect(await erc20BalanceOf(sandbox.clients.l1, feeAsset, l1.address), "the chain credited exactly one mint").toBe(before + perCall)
	expect(l1.signatures, "the mint was one Ethereum transaction").toBe(1)

	await sendTab()
	await expect(balance).toHaveText(formatBigInt(before + perCall, 18), { timeout: 60_000 })
})
