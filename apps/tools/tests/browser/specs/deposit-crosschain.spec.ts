/**
 * Deposits that start on the sandbox's source chain (cells 50–54): the route rides fixed testnet terms, the relay loop
 * fills it as the exclusive filler those terms name, LI.FI's compiled receiver and Executor run it into the deposit
 * router, and the app finds it by discovery alone. Every amount stays under the fixed terms' cap of 8 whole tokens.
 */
import { DEPOSIT_ROUTER_ABI, FILLED_RELAY_TOPIC, TESTNET_FILLER } from "@unleashed/bridge-core"
import { balanceOf, erc20BalanceOf, mint, SET_PAUSED_ABI, SPOKE_POOL_ABI, writeL1 } from "@unleashed/bridge-core/sandbox"
import { type Address, decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, type Hex, maxUint256, pad, zeroHash } from "viem"
import type { Page } from "@playwright/test"
import { TESTIDS } from "../../../src/lib/testids"
import { expect, type SandboxAccess, test } from "../fixtures/test"
import type { L1WalletControl } from "../fixtures/l1-wallet"
import type { RelayerControl } from "../fixtures/relayer"
import { connectAztec, driveToConnected, tid } from "../pages/connect"
import {
	type CrossChainPlan,
	type CrossChainRecord,
	crossChainCard,
	crossChainRecordWhen,
	expectCardPhase,
	reviewCrossChain,
	signOnSource,
} from "../pages/crosschain"
import { transactionFeeOf } from "../pages/journal"
import { connectL1, openSend, waitForReceipt } from "../pages/send"

test.use({ family: "deposit-crosschain", cells: 5, l1Index: 9 })

const USDC = 10n ** 6n
const ETHEREUM = 31337
/** Five whole tokens: under the fixed terms' cap, and enough for the gas slice and a token leg. */
const SEND = 5n * USDC

/** The source token, minted to the wallet's account on the source chain; nothing else holds any there. */
async function fundSource(relayer: RelayerControl, l1: L1WalletControl, amount: bigint) {
	const { source } = relayer.cc.handle
	await mint(relayer.cc.source, source.token as Address, l1.address, amount)
	return { srcChainId: relayer.cc.handle.sourceChainId, srcToken: source.token as Address, diamond: getAddress(source.diamond) }
}

const planOf = (src: { srcChainId: number; srcToken: Address }, intent: CrossChainPlan["intent"], isPrivate: boolean): CrossChainPlan => ({
	...src,
	amount: "5",
	intent,
	isPrivate,
})

async function sendFromSource(page: Page, actor: { address: string }, plan: CrossChainPlan) {
	await page.goto("/")
	await openSend(page)
	await connectL1(page)
	await connectAztec(page, { profile: "plain", account: actor.address })
	await reviewCrossChain(page, plan)
	await signOnSource(page, plan.srcChainId)
}

/** The record once its source transaction is known and the rail named its transport: the relay has it. */
const bridging = (page: Page) =>
	crossChainRecordWhen(page, (r) => Boolean(r.route.srcTxHash && r.route.transport), "the source send is on the rail")

/** The user moves the wallet back to Ethereum once the send has left the source chain: the claim's Ethereum checks read
 *  through the wallet (`validateTokenBlock`), and the app offers no switch away from a source chain. */
const walletBackOnEthereum = (l1: L1WalletControl) => l1.setChainId(ETHEREUM)

/** A record this page did not send is claimed from its card, which a reloaded page shows. */
async function claimFromCard(page: Page, id: string) {
	const card = await crossChainCard(page, id)
	const claim = card.locator(tid(TESTIDS.journalClaim))
	const done = page.locator(`${tid(TESTIDS.journalCard)}[data-id="${id}"][data-stage="done"]`)
	await expect(claim.or(done).first()).toBeVisible({ timeout: 300_000 })
	if (await claim.isVisible()) await claim.click()
	await expect(card).toHaveAttribute("data-stage", "done", { timeout: 8 * 60_000 })
}

async function reloadAndReconnect(page: Page, actor: { address: string }) {
	await page.reload()
	await openSend(page)
	await connectL1(page)
	await driveToConnected(page, { profile: "plain", account: actor.address })
}

/** What the relay loop filled for this record on Ethereum: its `FilledRelay`, and who the pool logged as relayer. */
async function fillOf(sandbox: SandboxAccess, relayer: RelayerControl, rec: CrossChainRecord) {
	const relayHash = rec.route.transport?.relayHash as Hex
	const status = await sandbox.clients.l1.pub.readContract({
		address: relayer.cc.handle.destination.spokePool as Address,
		abi: SPOKE_POOL_ABI,
		functionName: "fillStatuses",
		args: [relayHash],
	})
	return { relayHash, status }
}

test("cell 50 — public token + gas from the source chain: a standing MAX allowance is replaced by the exact amount, two transactions without a batch, filled by the exclusive filler, claimed with the fuel it bridged", async ({
	page,
	sandbox,
	actor,
	l1,
	relayer,
}) => {
	const src = await fundSource(relayer, l1, SEND)
	await l1.sendOutside(src.srcChainId, {
		to: src.srcToken,
		data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [src.diamond, maxUint256] }),
	})
	const usdcL2 = await actor.l2TokenOf(sandbox.tokens.usdc)
	const before = await balanceOf(usdcL2, actor.actor.address, "public")
	const fjBefore = await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public")
	await relayer.syncSourceClock()

	await sendFromSource(page, actor, planOf(src, "token+gas", false))
	await bridging(page)
	await walletBackOnEthereum(l1)
	await waitForReceipt(page)
	const rec = await crossChainRecordWhen(page, (r) => r.completedAt !== undefined, "the record completed")

	expect(l1.calls("wallet_switchEthereumChain"), "the review asked the wallet onto the source chain").toBeGreaterThanOrEqual(1)
	expect(l1.calls("wallet_getCapabilities"), "the wallet was asked whether it batches").toBeGreaterThanOrEqual(1)
	expect(l1.calls("wallet_sendCalls"), "no atomic batch is offered, so none is sent").toBe(0)
	expect(l1.calls("eth_sendTransaction"), "the approval, then the deposit").toBe(2)
	const approval = await relayer.cc.source.pub.getTransaction({ hash: rec.approveTxHash as Hex })
	const approved = decodeFunctionData({ abi: erc20Abi, data: approval.input })
	expect(approved.functionName).toBe("approve")
	expect(approved.args, "exactly the input, to the Diamond, in place of MAX").toEqual([src.diamond, SEND])
	const left = await relayer.cc.source.pub.readContract({
		address: src.srcToken,
		abi: erc20Abi,
		functionName: "allowance",
		args: [l1.address, src.diamond],
	})
	expect(left, "the deposit spent the exact allowance; nothing stands").toBe(0n)

	const fill = await fillOf(sandbox, relayer, rec)
	expect(fill.status, "filled on Ethereum").toBe(2n)
	const fillReceipt = await sandbox.clients.l1.pub.getTransactionReceipt({ hash: rec.depositTxHash as Hex })
	const filled = fillReceipt.logs.find((l) => l.topics[0] === FILLED_RELAY_TOPIC)
	expect(filled?.topics[3], "the pool logged the fixed terms' exclusive filler as relayer").toBe(pad(TESTNET_FILLER.toLowerCase() as Hex))

	const gained = (await balanceOf(usdcL2, actor.actor.address, "public")) - before
	expect(gained, "the token leg the router deposited arrived").toBe(BigInt(rec.amount))
	const received = BigInt(rec.fuel?.received ?? "0")
	expect(received, "the gas leg bridged Fee Juice").toBeGreaterThan(0n)
	const fee = await transactionFeeOf(actor.s.l2.node, rec.claimTxHash as string)
	expect(await balanceOf(actor.s.feeJuiceL2, actor.actor.address, "public"), "public FJ = the fuel minus the claim's own fee").toBe(
		fjBefore + received - fee,
	)
})

test("cell 51 — private token + gas through one atomic batch, reloaded before the wallet reports its receipts: discovery finds the transaction and the claim unseals from the journal", async ({
	page,
	sandbox,
	actor,
	l1,
	relayer,
}) => {
	const src = await fundSource(relayer, l1, SEND)
	l1.atomicOn(src.srcChainId)
	l1.holdBatchReceipts()
	const usdcL2 = await actor.l2TokenOf(sandbox.tokens.usdc)
	const before = await balanceOf(usdcL2, actor.actor.address, "private")
	await relayer.syncSourceClock()

	await sendFromSource(page, actor, planOf(src, "token+gas", true))
	const sent = await crossChainRecordWhen(page, (r) => r.route.srcBatchId !== undefined, "the batch id is journaled")
	expect(sent.route.srcTxHash, "the wallet reported no receipt yet").toBeUndefined()
	const [batch] = l1.batches()
	expect(l1.batches()).toHaveLength(1)
	expect(batch.atomicRequired, "the batch asks for atomicity").toBe(true)
	expect(batch.chainId).toBe(src.srcChainId)
	expect(
		batch.calls.map((c) => c.to.toLowerCase()),
		"the exact approval, then the deposit",
	).toEqual([src.srcToken.toLowerCase(), src.diamond.toLowerCase()])
	expect(decodeFunctionData({ abi: erc20Abi, data: batch.calls[0].data as Hex }).args).toEqual([src.diamond, SEND])
	expect(l1.calls("eth_sendTransaction"), "nothing left the page outside the batch").toBe(0)

	await walletBackOnEthereum(l1)
	await reloadAndReconnect(page, actor)
	await claimFromCard(page, sent.id)
	const rec = await crossChainRecordWhen(page, (r) => r.completedAt !== undefined, "the record completed")
	expect(rec.route.srcTxHash?.toLowerCase(), "discovery adopted the batch's deposit transaction").toBe(batch.hashes[1]?.toLowerCase())
	expect(rec.claimTxHash).toBeTruthy()
	const gained = (await balanceOf(usdcL2, actor.actor.address, "private")) - before
	expect(gained, "the private token leg arrived").toBe(BigInt(rec.amount))
	expect(l1.calls("personal_sign"), "the seal before the send, and the unseal after the reload").toBeGreaterThanOrEqual(2)
})

test("cell 52 — reloaded while bridging, with another deposit for the same credential: the watch resumes, names the extra deposit, and claims only its own", async ({
	page,
	sandbox,
	actor,
	l1,
	relayer,
}) => {
	const src = await fundSource(relayer, l1, SEND)
	const usdc = sandbox.tokens.usdc
	const usdcL2 = await actor.l2TokenOf(usdc)
	const before = await balanceOf(usdcL2, actor.actor.address, "public")
	await relayer.setMode({ kind: "delay", ms: 60_000 })
	await relayer.syncSourceClock()

	await sendFromSource(page, actor, planOf(src, "token+gas", false))
	const sent = await bridging(page)
	await walletBackOnEthereum(l1)
	expect(sent.leafIndex, "not deposited yet").toBeUndefined()

	// Anyone may deposit for a credential they have seen; at or above the floor it is a gift only this user can claim.
	const floor = BigInt(sent.route.minReceived) - BigInt(sent.fuel?.amount ?? "0")
	const router = sandbox.manifest.bridge?.l1.depositRouter as Address
	const gift = {
		token: usdc.erc20 as Address,
		aztecRecipient: actor.address as Hex,
		tokenSecretHash: sent.id as Hex,
		isPrivate: false,
		fuelSlice: 0n,
		fuelRecipient: zeroHash,
		fuelSecretHash: zeroHash,
		minFuelOutput: 0n,
	}
	await mint(sandbox.clients.l1, usdc.erc20 as Address, sandbox.clients.l1.account.address, floor)
	await writeL1(sandbox.clients.l1, usdc.erc20 as Address, erc20Abi, "approve", [router, floor])
	const giftTx = await writeL1(sandbox.clients.l1, router, DEPOSIT_ROUTER_ABI, "bridgeFromCaller", [gift, "0x", floor, floor])

	await reloadAndReconnect(page, actor)
	await claimFromCard(page, sent.id)
	const rec = await crossChainRecordWhen(page, (r) => r.completedAt !== undefined, "the record completed")
	expect(
		rec.route.extraDeposits?.map((e) => e.txHash.toLowerCase()),
		"the gift is recorded as an extra deposit",
	).toEqual([giftTx.toLowerCase()])
	expect(rec.depositTxHash?.toLowerCase(), "the claimed deposit is the relay's, not the gift").not.toBe(giftTx.toLowerCase())
	const card = await crossChainCard(page, rec.id)
	await expect(card.locator(tid(TESTIDS.journalXcAnotherDeposit))).toBeVisible()
	const gained = (await balanceOf(usdcL2, actor.actor.address, "public")) - before
	expect(gained, "only the intended deposit was claimed").toBe(BigInt(rec.amount))
	expect(l1.calls("eth_sendTransaction"), "the reload resent nothing").toBe(2)
})

test("cell 53 — deposits paused when the fill lands: LI.FI's receiver recovers the delivery to the user's Ethereum address, and the card says delivered to wallet", async ({
	page,
	sandbox,
	actor,
	l1,
	relayer,
}) => {
	const src = await fundSource(relayer, l1, SEND)
	const usdc = sandbox.tokens.usdc.erc20 as Address
	const factory = sandbox.manifest.bridge?.l1.factory as Address
	const usdcL2 = await actor.l2TokenOf(sandbox.tokens.usdc)
	const l2Before = await balanceOf(usdcL2, actor.actor.address, "public")
	const l1Before = await erc20BalanceOf(sandbox.clients.l1, usdc, l1.address)
	await relayer.setMode({ kind: "delay", ms: 30_000 })
	await relayer.syncSourceClock()

	await sendFromSource(page, actor, planOf(src, "token+gas", false))
	const sent = await bridging(page)
	await writeL1(sandbox.clients.l1, factory, SET_PAUSED_ABI, "setPaused", [true, false])
	try {
		await expectCardPhase(page, sent.id, "delivered")
	} finally {
		await writeL1(sandbox.clients.l1, factory, SET_PAUSED_ABI, "setPaused", [false, false])
	}
	const rec = await crossChainRecordWhen(page, (r) => r.route.outcome === "delivered-to-wallet", "the outcome is journaled")
	expect(rec.route.outcomeAmount, "the whole delivery was recovered").toBe(rec.route.minReceived)
	expect((await erc20BalanceOf(sandbox.clients.l1, usdc, l1.address)) - l1Before, "it landed at the user's Ethereum address").toBe(
		BigInt(rec.route.minReceived),
	)
	expect(rec.leafIndex, "nothing was deposited for Aztec").toBeUndefined()
	expect(await balanceOf(usdcL2, actor.actor.address, "public")).toBe(l2Before)
	expect((await fillOf(sandbox, relayer, rec)).status, "the relay itself was filled").toBe(2n)
})

test("cell 54 — a fill starved of gas reverts and nobody else may fill: past the deadline the card says expired, and the input waits in the source pool", async ({
	page,
	sandbox,
	actor,
	l1,
	relayer,
}) => {
	const src = await fundSource(relayer, l1, SEND)
	const pool = relayer.cc.handle.source.spokePool as Address
	const poolBefore = await erc20BalanceOf(relayer.cc.source, src.srcToken, pool)
	await relayer.setMode({ kind: "starve-gas" })
	await relayer.syncSourceClock()

	await sendFromSource(page, actor, planOf(src, "token+gas", false))
	const sent = await bridging(page)
	expect(sent.route.terms, "a fixed-terms send").toBe("fixed")
	await relayer.passOnEthereum(sent.route.fillDeadline as number)
	await expectCardPhase(page, sent.id, "expired")

	const rec = await crossChainRecordWhen(page, (r) => r.route.outcome === "expired-on-source", "the outcome is journaled")
	expect((await fillOf(sandbox, relayer, rec)).status, "the starved fill reverted whole: unfilled").toBe(0n)
	expect(rec.leafIndex).toBeUndefined()
	expect((await erc20BalanceOf(relayer.cc.source, src.srcToken, pool)) - poolBefore, "the input is still in the source pool").toBe(SEND)
})
