/** Held-gas claims, the private fuel leg, the swap floor binding, every gas-only shape, a send sized
 *  from the swapper's probe the way the app sizes it, and the Outbox round trip. Same contract as
 *  `flows.ts`: pure functions of a context. */
import { SetPublicAuthwitContractInteraction } from "@aztec-labs/aztec.js/authorization"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TestERC20Abi } from "@aztec-foundation/l1-artifacts"
import type { Address, Hex } from "viem"
import { TOKEN_PORTAL_ABI } from "../../src/factory-abi"
import { consumeWithdrawal, isOutboxMessageConsumed } from "../../src/flows"
import { proposeGasShare } from "../../src/gas-share"
import { exitViaHub, type HubExitParams, preflightHubExit } from "../../src/hub-l2"
import type { JournalTokenBlock } from "../../src/journal"
import type { ManifestToken } from "../../src/manifest-v2"
import { deriveBridgeSecret, ownGasTxs, PRIVATE_FPC_ADDRESS, PRIVATE_HUB_CLAIM_GAS } from "../../src/private-fuel"
import { manifestFuelProvider } from "../../src/fuel-quote"
import { waitForL1ToL2Message } from "../generation"
import { ensureRouterPermit2 } from "../script-l1"
import { planFuelLeg } from "../script-send"
import { flowGasOnly, flowTokenPlusGas, GAS_ONLY_AMOUNT, TOKEN_PLUS_GAS_FUEL_UNITS } from "./flows"
import { MIN_FJ, PERMIT2, SWAPPER_FJ_PER_WHOLE_TOKEN, ZERO_L1 } from "./constants"
import {
	balanceOf,
	claim,
	exitCeiling,
	fpcClaimFee,
	fuelClaimFee,
	fuelLeg,
	fuelSwapperOf,
	mintPrivateGasNote,
	mintPrivateGasVia,
	type PrivateGasLeg,
	privateCreditFee,
	privateCreditOf,
	privateFpc,
	send,
	settled,
	type SmokeContext,
} from "./context"
import { erc20BalanceOf, freshToken, mint, mintFeeAsset, setFuelRate } from "./l1"
import { withBlockHeartbeat } from "./l2"

const toWei = (token: ManifestToken, whole: bigint) => whole * 10n ** BigInt(token.decimals)

// ─── Held gas ────────────────────────────────────────────────────────────────

/** Funds the actor's PUBLIC Fee Juice through the portal (the fee asset's identity route). */
export async function fundPublicFeeJuice(s: SmokeContext, amount: bigint): Promise<void> {
	const feeAsset = s.clients.deployment.feeJuice
	await mintFeeAsset(s.l1, feeAsset, s.l1.account.address, amount)
	await ensureRouterPermit2(s.l1, { usdc: feeAsset, usdcAbi: TestERC20Abi, permit2: PERMIT2, needed: amount, mins: s.mins })
	const res = await send(s, s.l1, {
		intent: "gas",
		erc20: feeAsset,
		amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: { fuelAmount: amount, fuelRecipient: s.l2.from.toString() as Hex, minFuelOutput: amount, swapData: "0x" },
	})
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const before = await balanceOf(s.feeJuiceL2, s.l2.from, "public")
	await s.feeJuiceL2.methods
		.claim(s.l2.from, amount, Fr.fromHexString(res.fuelSecretHex as string), new Fr(res.fuelLeafIndex as bigint))
		.send(s.l2.sendOpts as never)
	// A caller reads this balance next: it must already show the funding.
	await settled(
		() => balanceOf(s.feeJuiceL2, s.l2.from, "public"),
		(v) => v >= before + amount,
		"the public Fee Juice after the claim",
	)
}

/** Cell 5: a token-only claim whose fee comes from Fee Juice the account already holds — no fee
 *  method named, so the wallet's own default (its public balance) pays, and the contracts accept it. */
export async function flowTokenOnlyHeldPublicFj(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const amount = toWei(token, 10n)
	await fundPublicFeeJuice(s, 5n * MIN_FJ)
	const fjBefore = await balanceOf(s.feeJuiceL2, s.l2.from, "public")
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	const before = await balanceOf(l2Token, s.l2.from, "public")
	const res = await send(s, s.l1, {
		intent: "token",
		erc20: token.erc20 as Address,
		amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
	})
	// `fee: {}` names no payment method: the embedded wallet falls to PREEXISTING_FEE_JUICE.
	const outcome = await claim(s, res, { amount, isPrivate: false, recipient: s.l2.from, fee: {}, feeMode: "fee-juice" })
	const gained = (await balanceOf(l2Token, s.l2.from, "public")) - before
	const fjSpent = fjBefore - (await balanceOf(s.feeJuiceL2, s.l2.from, "public"))
	if (gained < amount) throw new Error(`balance rose by ${gained}, expected ${amount}`)
	if (fjSpent <= 0n) throw new Error("the claim did not spend the account's held public Fee Juice")
	return `${outcome.path} paid ${fjSpent} FJ-wei from held public Fee Juice`
}

// ─── The fuel leg ────────────────────────────────────────────────────────────

/** Cell 14: a fueled public claim leaves held private credit untouched. */
export async function flowTokenPlusGasWithCreditHeld(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const fpc = await privateFpc(s)
	await mintPrivateGasNote(s, fpc, (await exitCeiling(s)) * 2n)
	const creditBefore = await privateCreditOf(s, fpc)
	const unit = 10n ** BigInt(token.decimals)
	const total = 100n * unit
	const fuelAmount = 40n * unit
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, total)
	const res = await send(s, s.l1, {
		intent: "token+gas",
		erc20: token.erc20 as Address,
		amount: total,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: { fuelAmount, fuelRecipient: s.l2.from.toString() as Hex, ...(await fuelLeg(s, token.erc20 as Address, fuelAmount)) },
	})
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const before = await balanceOf(l2Token, s.l2.from, "public")
	const outcome = await claim(s, res, {
		amount: total - fuelAmount,
		isPrivate: false,
		recipient: s.l2.from,
		fee: fuelClaimFee(s, res),
		feeMode: "fee-juice",
	})
	const gained = (await balanceOf(l2Token, s.l2.from, "public")) - before
	if (gained < total - fuelAmount) throw new Error(`token leg credited ${gained}, expected ${total - fuelAmount}`)
	const creditAfter = await privateCreditOf(s, fpc)
	if (creditAfter !== creditBefore) throw new Error(`the fueled claim touched the private credit (${creditBefore} → ${creditAfter})`)
	return `${outcome.path} paid by its own fuel; private credit ${creditAfter} untouched`
}

/** Cells 15 + 16: a PRIVATE deposit whose fuel goes to the PrivateFPC, which pays the claim from the
 *  credit that fuel becomes — on a registered token, or a fresh one (registration-then-credit). */
export async function flowTokenPlusGasPrivate(
	s: SmokeContext,
	base: ManifestToken | undefined,
	l2TokenOf: (b: JournalTokenBlock) => Promise<ContractBase>,
): Promise<string> {
	await privateFpc(s)
	const unit = 10n ** 6n
	const total = 100n * unit
	const fuelAmount = 40n * unit
	const bridgeSalt = Fr.random()
	const erc20 = base
		? (base.erc20 as Address)
		: await freshToken(s.l1, { name: "Private Fuel", symbol: "PFUEL", decimals: 6 }, [s.l1.account.address], total)
	if (base) await mint(s.l1, erc20, s.l1.account.address, total)
	else await setFuelRate(s.l1, fuelSwapperOf(s), erc20)
	const res = await send(s, s.l1, {
		intent: "token+gas",
		erc20,
		amount: total,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: true,
		claimSalt: Fr.random(),
		gas: {
			fuelAmount,
			fuelRecipient: PRIVATE_FPC_ADDRESS as Hex,
			...(await fuelLeg(s, erc20, fuelAmount)),
			fuelSecret: deriveBridgeSecret(bridgeSalt, s.l2.from),
		},
	})
	const block = res.token as JournalTokenBlock
	if (!base) await waitForL1ToL2Message(s.l2.node, block.registerKey as string, { forceBlock: s.l2.forceBlock })
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const l2Token = await l2TokenOf(block)
	// A fresh token's instance does not exist until the registration deploys it: nothing to read.
	const before = base ? await balanceOf(l2Token, s.l2.from, "private") : 0n
	// A private first claim registers in a transaction of its own, which is what spends the fuel;
	// the claim behind it pays from the credit the FPC kept — the app's split exactly.
	const registeredClaimFee = base ? undefined : (await privateCreditFee(s, PRIVATE_HUB_CLAIM_GAS)).fee
	const outcome = await claim(s, res, {
		amount: total - fuelAmount,
		isPrivate: true,
		recipient: s.l2.from,
		fee: await fpcClaimFee(s, res, bridgeSalt),
		registeredClaimFee,
		feeMode: "private-fpc",
	})
	const gained = (await balanceOf(l2Token, s.l2.from, "private")) - before
	if (gained < total - fuelAmount) throw new Error(`private token leg credited ${gained}, expected ${total - fuelAmount}`)
	const expected = base ? "claim" : "register,claim"
	if (outcome.path !== expected) throw new Error(`expected ${expected}, got ${outcome.path}`)
	return `${outcome.path} privately, its fee paid by the PrivateFPC from the fuel the same send minted`
}

/** Cell 17: a floor above what the venue pays reverts at settlement — the router's slippage bound,
 *  not a silent under-delivery. Nothing lands on L1. */
export async function flowMinFuelFloorBinds(s: SmokeContext, token: ManifestToken): Promise<string> {
	const unit = 10n ** BigInt(token.decimals)
	const total = 100n * unit
	const fuelAmount = 40n * unit
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, total)
	const fuel = await planFuelLeg(s.l1.pub, s.manifest, token.erc20 as Address, fuelAmount)
	let refused = ""
	try {
		await send(s, s.l1, {
			intent: "token+gas",
			erc20: token.erc20 as Address,
			amount: total,
			aztecRecipient: s.l2.from.toString() as Hex,
			isPrivate: false,
			// The swap call keeps the quote's own floor, so the venue settles and the router's check is what binds.
			gas: { fuelAmount, fuelRecipient: s.l2.from.toString() as Hex, minFuelOutput: fuel.quote + 1n, swapData: fuel.swapData },
		})
	} catch (e) {
		refused = e instanceof Error ? e.message : String(e)
	}
	if (!refused) throw new Error("a send whose floor exceeds the venue's output settled")
	// The router's own floor check is what reverts, not a Permit2 or allowance error on the way there.
	if (!/insufficient ?(fuel|output)/i.test(refused))
		throw new Error(`the floor was refused with "${refused.slice(0, 120)}", not an insufficient-output revert`)
	return `floor one wei above the venue's output → settlement reverted on the floor (${refused.slice(0, 60)}…)`
}

// ─── Gas only, every shape ───────────────────────────────────────────────────

/** Cell 19: gas only, private — the fee asset bridged straight into PrivateFPC credit. */
export async function flowGasOnlyPrivate(s: SmokeContext): Promise<string> {
	const fpc = await privateFpc(s)
	const before = await privateCreditOf(s, fpc)
	const gained = await mintPrivateGasNote(s, fpc, 3n * MIN_FJ)
	const after = await privateCreditOf(s, fpc)
	if (after - before !== gained) throw new Error(`credit moved by ${after - before}, minted ${gained}`)
	return `fee asset → PrivateFPC credit, +${gained} FJ-wei private gas`
}

export const GAS_ONLY_SWAPPED_UNITS = 30n

/** The private half of a swapped or routed gas-only shape: the same leg, bought into PrivateFPC
 *  credit, which the fixed rate makes exactly the quote. The note joins the inventory. */
async function privateGasOnly(s: SmokeContext, leg: PrivateGasLeg, expected: bigint, what: string): Promise<string> {
	const fpc = await privateFpc(s)
	const gained = await mintPrivateGasVia(s, fpc, leg)
	if (gained !== expected) throw new Error(`${what} credited ${gained} FJ-wei of private gas, expected ${expected}`)
	s.credit.notes.push(gained)
	return `${what} → +${gained} FJ-wei private gas at the PrivateFPC`
}

/** Cell 20: gas only through a SWAPPED token (USDC → FJ via the venue), public or private. */
export async function flowGasOnlySwapped(s: SmokeContext, token: ManifestToken, isPrivate = false): Promise<string> {
	const amount = toWei(token, GAS_ONLY_SWAPPED_UNITS)
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, amount)
	return gasOnlyAtQuote(s, token.erc20 as Address, amount, isPrivate, `${amount} ${token.displaySymbol}-units swapped`)
}

/** A gas-only send of `amount` at the swapper's quote, into public Fee Juice or PrivateFPC credit;
 *  the fixed rate makes what lands exactly the quote. */
async function gasOnlyAtQuote(s: SmokeContext, erc20: Address, amount: bigint, isPrivate: boolean, what: string): Promise<string> {
	const fuel = await planFuelLeg(s.l1.pub, s.manifest, erc20, amount)
	const leg = { swapData: fuel.swapData, minFuelOutput: fuel.minFuelOutput }
	if (isPrivate) return privateGasOnly(s, { erc20, amount, ...leg }, fuel.quote, what)
	const res = await send(s, s.l1, {
		intent: "gas",
		erc20,
		amount,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: { fuelAmount: amount, fuelRecipient: s.l2.from.toString() as Hex, ...leg },
	})
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const before = await balanceOf(s.feeJuiceL2, s.l2.from, "public")
	await s.feeJuiceL2.methods
		.claim(s.l2.from, res.fuelReceived ?? 0n, Fr.fromHexString(res.fuelSecretHex as string), new Fr(res.fuelLeafIndex as bigint))
		.send(s.l2.sendOpts as never)
	const gained = (await balanceOf(s.feeJuiceL2, s.l2.from, "public")) - before
	if (gained !== fuel.quote) throw new Error(`${what}: credited ${gained} FJ-wei of public gas, quoted ${fuel.quote}`)
	return `${what} → +${gained} FJ-wei public gas`
}

/** Cell 21: an 18-decimal token (WETH) gas-only, priced by the rate the swapper holds for it, public or
 *  private. The rate is set here: no fixture token but the manifest's fuels by default. */
export async function flowGasOnlyWeth(s: SmokeContext, isPrivate = false): Promise<string> {
	const weth = s.clients.deployment.tokens.weth
	const amount = 2n * 10n ** 18n
	await setFuelRate(s.l1, fuelSwapperOf(s), weth)
	await mint(s.l1, weth, s.l1.account.address, amount)
	return gasOnlyAtQuote(s, weth, amount, isPrivate, "18-decimal WETH at its own rate")
}

// ─── The probed slice ────────────────────────────────────────────────────────

/** Cell 23: the production shape end to end — probe the swapper's rate with one unit, size the slice
 *  the way the app does, quote at exactly that slice, send, and claim from the fuel the venue delivered. */
export async function flowDiscoveredRouteSend(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const budgets = s.bridge.l1.fuel
	const provider = manifestFuelProvider(s.manifest, s.l1.pub)
	if (!budgets || !provider) throw new Error("the sandbox manifest has no deposit router with fuel budgets")
	const unit = 10n ** BigInt(token.decimals)
	const total = 100n * unit
	const probe = await provider.probe(token.erc20 as Address, unit)
	if (!probe.ok) throw new Error(`the swapper gave no probe for ${token.displaySymbol}: ${probe.reason}`)
	const share = proposeGasShare({
		amount: total,
		decimals: token.decimals,
		txTarget: 20,
		fjPerTx: BigInt(budgets.fjPerTx),
		minFuelFj: BigInt(budgets.minFuelFj),
		rate: probe.probe,
		slippageBps: budgets.slippageBps,
	})
	const fuelAmount = share.fuelAmount
	const quoted = await provider.quote(token.erc20 as Address, fuelAmount)
	if (!quoted.ok) throw new Error(`the swapper gave no quote at the slice: ${quoted.reason}`)
	const { swapData, minOut, expectedOut } = quoted.quote
	await mint(s.l1, token.erc20 as Address, s.l1.account.address, total)
	const res = await send(s, s.l1, {
		intent: "token+gas",
		erc20: token.erc20 as Address,
		amount: total,
		aztecRecipient: s.l2.from.toString() as Hex,
		isPrivate: false,
		gas: { fuelAmount, fuelRecipient: s.l2.from.toString() as Hex, minFuelOutput: minOut, swapData },
	})
	if ((res.fuelReceived ?? 0n) !== expectedOut) throw new Error(`the venue delivered ${res.fuelReceived}, the quote said ${expectedOut}`)
	await waitForL1ToL2Message(s.l2.node, res.fuelMessageHashHex as string, { forceBlock: s.l2.forceBlock })
	const before = await balanceOf(l2Token, s.l2.from, "public")
	const claimed = await claim(s, res, {
		amount: total - fuelAmount,
		isPrivate: false,
		recipient: s.l2.from,
		fee: fuelClaimFee(s, res),
		feeMode: "fee-juice",
	})
	const gained = (await balanceOf(l2Token, s.l2.from, "public")) - before
	if (gained < total - fuelAmount) throw new Error(`token leg credited ${gained}, expected ${total - fuelAmount}`)
	return `probed slice ${fuelAmount}, quote ${expectedOut} = delivered, floor ${minOut}; ${claimed.path}`
}

// ─── The Outbox ──────────────────────────────────────────────────────────────

/** Cell 32: an exit's L2→L1 message reads as NOT consumed the moment it is proposed, and after
 *  finalization the consume lands. Positive coverage only: the automine local network proves a
 *  block as soon as it is proposed, so the unproven window — in which the Outbox holds no root and
 *  refuses the consume — is not observable here. */
export async function flowOutboxRoundTrip(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const amount = toWei(token, 1n)
	const receipt = await sendPublicExit(s, token, l2Token, amount)
	if (await isOutboxMessageConsumed(s.l1, s.l2.node as never, receipt)) throw new Error("a just-proposed exit read as already consumed")
	const status = String((await s.l2.node.getTxReceipt(receipt.txHash as never)).status ?? "")
	const released = await finishExit(s, token, receipt, amount)
	return `exit ${status} at the first read, not consumed; after finalization the consume released ${released}`
}

/** The public burn's authwit, then the exit itself — PROPOSED when this returns. */
async function sendPublicExit(s: SmokeContext, token: ManifestToken, l2Token: ContractBase, amount: bigint): Promise<{ txHash: unknown }> {
	const authwitNonce = Fr.random()
	const exit: HubExitParams = {
		l2Token: token.l2Token,
		recipientL1: s.l1.account.address,
		amount,
		callerOnL1: ZERO_L1,
		authwitNonce,
		isPrivate: false,
	}
	const burn = l2Token.methods.burn_public(s.l2.from, amount, authwitNonce)
	const authwit = await SetPublicAuthwitContractInteraction.create(
		s.l2.wallet as never,
		s.l2.from,
		{ caller: s.hub.address, action: burn } as never,
		true,
	)
	await authwit.send(s.l2.sendOpts as never)
	await preflightHubExit(s.hub, exit, s.l2.from.toString())
	const { receipt } = (await exitViaHub(s.hub, exit, s.l2.sendOpts)) as unknown as { receipt: { txHash: unknown } }
	return receipt
}

/** Prove, witness, consume — the normal path — and return what L1 released. */
async function finishExit(s: SmokeContext, token: ManifestToken, receipt: { txHash: unknown }, amount: bigint): Promise<bigint> {
	const before = await erc20BalanceOf(s.l1, token.erc20 as Address, s.l1.account.address)
	await withBlockHeartbeat(s.l2, () =>
		consumeWithdrawal(s.l1, s.l2.node as never, receipt, {
			recipientL1: s.l1.account.address,
			amount,
			portal: token.portal as Address,
			portalAbi: TOKEN_PORTAL_ABI as never,
			provenTimeoutSec: 900,
		}),
	)
	const released = (await erc20BalanceOf(s.l1, token.erc20 as Address, s.l1.account.address)) - before
	if (released < amount) throw new Error(`L1 released ${released}, expected ${amount}`)
	return released
}

// ─── First-time tokens paid from held credit (cells 3 + 4) ───────────────────

/** A first-time token whose registration and claim are paid from private credit the actor already
 *  holds — public: one `register_and_claim_public`; private: a registration of its own, then the
 *  claim — followed by a second deposit of the same token that pays only a claim. `pay_fee` keeps
 *  each transaction's committed ceiling, so the deductions are exact and the second is smaller. */
export async function flowFirstTimeFromCredit(s: SmokeContext, isPrivate: boolean): Promise<string> {
	const fpc = await privateFpc(s)
	const amount = 10n * 10n ** 6n
	const kind = isPrivate ? "private" : "public"
	const erc20 = await freshToken(
		s.l1,
		{ name: `Credit First ${kind}`, symbol: isPrivate ? "CFP" : "CFU", decimals: 6 },
		[s.l1.account.address],
		amount * 2n,
	)
	const first = ownGasTxs({ isPrivate, registers: true })
	const claimFee = await privateCreditFee(s, first.claim)
	const registerFee = first.register ? await privateCreditFee(s, first.register) : undefined
	const againFee = await privateCreditFee(s, ownGasTxs({ isPrivate, registers: false }).claim)
	const firstCeiling = claimFee.ceiling + (registerFee?.ceiling ?? 0n)
	await mintPrivateGasNote(s, fpc, firstCeiling + againFee.ceiling)

	const deposit = () =>
		send(s, s.l1, {
			intent: "token",
			erc20,
			amount,
			aztecRecipient: s.l2.from.toString() as Hex,
			isPrivate,
			...(isPrivate ? { claimSalt: Fr.random() } : {}),
		})
	const creditStart = await privateCreditOf(s, fpc)
	const res = await deposit()
	const one = await claim(s, res, {
		amount,
		isPrivate,
		recipient: s.l2.from,
		fee: claimFee.fee,
		registerFee: registerFee?.fee,
		registeredClaimFee: registerFee ? claimFee.fee : undefined,
		feeMode: "private-fpc",
	})
	const expected = isPrivate ? "register,claim" : "register+claim"
	if (one.path !== expected) throw new Error(`expected ${expected}, got ${one.path}`)
	const afterFirst = await privateCreditOf(s, fpc)
	if (creditStart - afterFirst !== firstCeiling) {
		throw new Error(`the first-time send deducted ${creditStart - afterFirst}, not its ceiling ${firstCeiling}`)
	}
	const two = await claim(s, await deposit(), { amount, isPrivate, recipient: s.l2.from, fee: againFee.fee, feeMode: "private-fpc" })
	if (two.path !== "claim") throw new Error(`expected a plain claim the second time, got ${two.path}`)
	const afterSecond = await privateCreditOf(s, fpc)
	if (afterFirst - afterSecond !== againFee.ceiling) {
		throw new Error(`the second send deducted ${afterFirst - afterSecond}, not its ceiling ${againFee.ceiling}`)
	}
	if (againFee.ceiling >= firstCeiling)
		throw new Error(`the second send (${againFee.ceiling}) was not cheaper than the first (${firstCeiling})`)
	const balance = await balanceOf(await s.l2TokenOf(res.token as JournalTokenBlock), s.l2.from, kind)
	if (balance < amount * 2n) throw new Error(`${kind} balance ${balance} < ${amount * 2n}`)
	return `${one.path} then ${two.path} from credit: ${firstCeiling} then ${againFee.ceiling} FJ-wei kept by the FPC`
}

// ─── Held public Fee Juice beside each fueled shape (cells 13b, 15b, 18b, 20b) ─

const HELD_FJ = 5n * MIN_FJ

async function withPublicFjHeld(s: SmokeContext, run: () => Promise<string>): Promise<{ line: string; before: bigint; after: bigint }> {
	await fundPublicFeeJuice(s, HELD_FJ)
	const before = await balanceOf(s.feeJuiceL2, s.l2.from, "public")
	const line = await run()
	return { line, before, after: await balanceOf(s.feeJuiceL2, s.l2.from, "public") }
}

function conserved(label: string, r: { before: bigint; after: bigint }, claimed: bigint, fee: bigint): string {
	if (r.after !== r.before + claimed - fee) {
		throw new Error(
			`${label}: public FJ ${r.before} → ${r.after}, expected ${r.before + claimed - fee} (+${claimed} claimed, −${fee} fee)`,
		)
	}
	return `held public FJ conserved: ${r.before} + ${claimed} − ${fee} = ${r.after}`
}

/** Cell 13b: the fueled claim lands its Fee Juice in the sender's own transaction — the held
 *  balance grows by what was bridged less the fee that transaction charged. */
export async function flowFueledClaimWithPublicFjHeld(s: SmokeContext, token: ManifestToken, l2Token: ContractBase): Promise<string> {
	const r = await withPublicFjHeld(s, () => flowTokenPlusGas(s, token, l2Token))
	const fee = s.samples.fees.at(-1)?.transactionFee ?? 0n
	return `${r.line}; ${conserved("fueled claim", r, TOKEN_PLUS_GAS_FUEL_UNITS * SWAPPER_FJ_PER_WHOLE_TOKEN, fee)}`
}

/** Cell 15b: a private fueled deposit never touches the held PUBLIC balance (the private fence). */
export async function flowPrivateFuelWithPublicFjHeld(
	s: SmokeContext,
	token: ManifestToken,
	l2TokenOf: (b: JournalTokenBlock) => Promise<ContractBase>,
): Promise<string> {
	const r = await withPublicFjHeld(s, () => flowTokenPlusGasPrivate(s, token, l2TokenOf))
	return `${r.line}; ${conserved("private fuel", r, 0n, 0n)}`
}

/** Cell 18b: the identity route adds to what is already held. */
export async function flowGasOnlyWithPublicFjHeld(s: SmokeContext): Promise<string> {
	const r = await withPublicFjHeld(s, () => flowGasOnly(s))
	return `${r.line}; ${conserved("identity route", r, GAS_ONLY_AMOUNT, 0n)}`
}

/** Cell 20b: the swapped route adds exactly its quote to what is already held. */
export async function flowGasOnlySwappedWithPublicFjHeld(s: SmokeContext, token: ManifestToken): Promise<string> {
	const r = await withPublicFjHeld(s, () => flowGasOnlySwapped(s, token))
	return `${r.line}; ${conserved("swapped route", r, GAS_ONLY_SWAPPED_UNITS * SWAPPER_FJ_PER_WHOLE_TOKEN, 0n)}`
}
