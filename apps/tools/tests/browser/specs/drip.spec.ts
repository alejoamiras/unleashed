/** The Drip tab (cells 35, 36, 38): faucet drips land on the selected account, and add-to-wallet fails open. */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { balanceOf, type DripDeploymentRecord, registerDripFixture } from "@unleashed/bridge-core/sandbox"
import { TESTIDS } from "../../../src/lib/testids"
import { expect, test } from "../fixtures/test"
import { connectAztec, tid } from "../pages/connect"
import { balancesShown, drip } from "../pages/drip"

test.use({ family: "drip", cells: 4, l1Index: 6 })

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
