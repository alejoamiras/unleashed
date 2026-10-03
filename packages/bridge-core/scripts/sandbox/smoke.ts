/** The smoke battery: every flow once on the base actor, in the order its state requires, each
 *  timed, with the sponsor paying whatever a flow does not price itself. The integration suite is
 *  where each cell runs on a fresh actor with the payer it claims; this is the CLI's one-shot form
 *  and the source of the calibration numbers an operator copies into a manifest. */
import type { ManifestV2 } from "../../src/manifest-v2"
import { PRIVATE_HUB_EXIT_GAS } from "../../src/private-fuel"
import { calibrateFuelBudgets } from "../calibration"
import { buildContext, type Samples, type SmokeContext, tokenBlockOf } from "./context"
import {
	flowConcurrentFirstClaims,
	flowGasOnly,
	flowGuardianPause,
	flowL1Pause,
	flowNoRoute,
	flowPortalOnlyToken,
	flowPrivateDeposit,
	flowPrivateGasFragmented,
	flowPrivateGasOneNote,
	flowPublicDeposit,
	flowRejectedRegistration,
	flowRelayedPrivateDeposit,
	flowRelayerFirstRegister,
	flowTokenPlusGas,
	runExit,
} from "./flows"
import {
	flowDiscoveredRouteSend,
	flowGasOnlyPrivate,
	flowGasOnlySwapped,
	flowGasOnlyWethSingleHop,
	flowMinFuelFloorBinds,
	flowOutboxRoundTrip,
	flowTokenOnlyHeldPublicFj,
	flowTokenPlusGasPrivate,
	flowTokenPlusGasWithCreditHeld,
} from "./flows-matrix"
import type { SandboxClients } from "./handle"
import type { Actor } from "./l2"

export interface FlowResult {
	label: string
	ok: boolean
	seconds: number
	line: string
}

async function timed(label: string, fn: () => Promise<string>): Promise<FlowResult> {
	const t0 = Date.now()
	try {
		const line = `✅ ${label} — ${await fn()}`
		console.log(line)
		return { label, ok: true, seconds: (Date.now() - t0) / 1000, line }
	} catch (e) {
		const line = `✗ ${label} — ${e instanceof Error ? e.message : String(e)}`
		console.log(line)
		return { label, ok: false, seconds: (Date.now() - t0) / 1000, line }
	}
}

export interface SmokeReport {
	results: FlowResult[]
	samples: Samples
	notes: string[]
}

/** What an operator copies into `bridge.l1.swap.{fjPerTx,fjRegister}` for a network whose fees these were. */
export function fuelBudgetNote(samples: Samples): string {
	const paid = samples.fees.filter((f) => f.feeMode !== "sponsored")
	if (paid.length === 0) return "ℹ calibration: no paid claim landed — fjPerTx/fjRegister not measured"
	const budgets = calibrateFuelBudgets(samples.fees)
	const worst = paid.map((f) => `${f.shape}/${f.feeMode}=${f.transactionFee}`).join(", ")
	return `ℹ calibration over ${paid.length} paid claims (${worst}) → fjPerTx=${budgets.fjPerTx} fjRegister=${budgets.fjRegister}`
}

/** What `PRIVATE_HUB_EXIT_GAS` is sized from: per exit, the simulation's billed gas (the landed fee
 *  equals it at the block's prices — asserted when sampled), and the ceiling the FPC kept in full. */
export function exitGasNotes(samples: Samples): string[] {
	if (samples.exitGas.length === 0) return ["ℹ private exit gas: no PrivateFPC-paid exit landed — PRIVATE_HUB_EXIT_GAS not measured"]
	return samples.exitGas.map(
		(x) =>
			`ℹ private exit (${x.label}: ${x.notes} credit note(s) spent, ${x.nullifiers} nullifiers) via PrivateFPC.pay_fee: ` +
			`simulated billed l2Gas=${x.simulated.l2Gas} daGas=${x.simulated.daGas}; ` +
			`landed fee=${x.fee} FJ-wei = that gas at the block's feePerL2Gas=${x.feePerL2Gas} feePerDaGas=${x.feePerDaGas}; ` +
			`credit charged ${x.charged} = the ceiling under declared limits l2Gas=${x.limits.l2Gas} daGas=${x.limits.daGas} ` +
			`(PRIVATE_HUB_EXIT_GAS l2Gas=${PRIVATE_HUB_EXIT_GAS.l2Gas} daGas=${PRIVATE_HUB_EXIT_GAS.daGas}, or this network's per-tx max where lower)`,
	)
}

/** Runs the whole battery on one actor and stops at the first failure, like the CLI always has. */
export async function runSmoke(clients: SandboxClients, manifest: ManifestV2, actor: Actor): Promise<SmokeReport> {
	const s: SmokeContext = await buildContext(clients, manifest, actor.address)
	const [usdc, usdt, pxo] = s.bridge.tokens
	if (!usdc || !usdt || !pxo) throw new Error("the sandbox manifest lists fewer than three tokens")
	const usdcL2 = await s.l2TokenOf(tokenBlockOf(usdc))
	const usdtL2 = await s.l2TokenOf(tokenBlockOf(usdt))
	const nort = s.clients.deployment.tokens.nort
	const unit = 10n ** BigInt(usdc.decimals)
	if (!nort) throw new Error("the deployment has no NORT token")

	const results: FlowResult[] = []
	const step = async (label: string, fn: () => Promise<string>) => {
		const r = await timed(label, fn)
		results.push(r)
		if (!r.ok) throw new Error(r.line)
	}
	console.log("\n=== smoke ===")
	await step("(a) public deposit → claim_public", () => flowPublicDeposit(s, usdc, usdcL2))
	await step("(b) private deposit → claim_private", () => flowPrivateDeposit(s, usdc, usdcL2))
	await step("(b) relayed private claim + wrong-recipient rejection", () => flowRelayedPrivateDeposit(s, usdc, usdcL2))
	await step("(c) token+gas, self-paying claim", () => flowTokenPlusGas(s, usdt, usdtL2))
	await step("(d) gas-only with the fee asset", () => flowGasOnly(s))
	await step("(d) private gas → one PrivateFPC credit note", () => flowPrivateGasOneNote(s))
	await step("(e) public exit → L1 withdraw", () => runExit(s, { token: usdc, l2Token: usdcL2, amount: 10n * unit, isPrivate: false }))
	await step("(e) private exit paid from one credit note → L1 withdraw", () =>
		runExit(s, { token: usdc, l2Token: usdcL2, amount: 5n * unit, isPrivate: true, label: "one note", notes: 1 }),
	)
	await step("(d) private gas → two more notes, none covering a ceiling", () => flowPrivateGasFragmented(s))
	await step("(e) private exit paid across three credit notes → L1 withdraw", () =>
		runExit(s, { token: usdc, l2Token: usdcL2, amount: 5n * unit, isPrivate: true, label: "three notes", notes: 3 }),
	)
	await step("(f1) relayer registers before the depositor claims", () => flowRelayerFirstRegister(s))
	await step("(f2) two concurrent first-time deposits", () => flowConcurrentFirstClaims(s))
	await step("(f3) portal-only token registers on its first claim", () => flowPortalOnlyToken(s, pxo))
	await step("(f4) routeless token refused before signing", () => flowNoRoute(s, nort))
	await step("(g) rejected registration, sponsored FPC", () => flowRejectedRegistration(s, "sponsored"))
	await step("(g) rejected registration, fee-juice-with-claim", () => flowRejectedRegistration(s, "fee-juice-claim"))
	await step("(g) rejected registration, private FPC", () => flowRejectedRegistration(s, "private-fpc"))
	await step("(h) guardian pause blocks exits, not claims", () => flowGuardianPause(s, usdc))
	await step("(h) factory pause: portals refuse deposits and withdraws first", () => flowL1Pause(s, usdc))
	// The matrix cells the battery gained with the Quoter facade.
	await step("(i) token-only claim paid from held public Fee Juice", () => flowTokenOnlyHeldPublicFj(s, usdc, usdcL2))
	await step("(i) discovered route → send → self-paying claim", () => flowDiscoveredRouteSend(s, usdt, usdtL2))
	await step("(i) fueled public claim leaves private credit untouched", () => flowTokenPlusGasWithCreditHeld(s, usdt, usdtL2))
	await step("(i) token+gas private, registered token", () => flowTokenPlusGasPrivate(s, usdt, s.l2TokenOf))
	await step("(i) token+gas private, first-time token", () => flowTokenPlusGasPrivate(s, undefined, s.l2TokenOf))
	await step("(i) floor above the venue's output refused", () => flowMinFuelFloorBinds(s, usdt))
	await step("(i) gas only, private credit", () => flowGasOnlyPrivate(s))
	await step("(i) gas only, swapped token", () => flowGasOnlySwapped(s, usdt))
	await step("(i) gas only, swapped token, private", () => flowGasOnlySwapped(s, usdt, true))
	await step("(i) gas only, WETH single hop", () => flowGasOnlyWethSingleHop(s))
	await step("(i) gas only, WETH single hop, private", () => flowGasOnlyWethSingleHop(s, true))
	await step("(i) outbox: not consumed at proposal, consumed after finalization", () => flowOutboxRoundTrip(s, usdc, usdcL2))
	const notes = [fuelBudgetNote(s.samples), ...exitGasNotes(s.samples)]
	for (const n of notes) console.log(n)
	return { results, samples: s.samples, notes }
}

export function durationTable(results: FlowResult[]): string {
	const width = Math.max(...results.map((r) => r.label.length))
	return results.map((r) => `${r.label.padEnd(width)}  ${r.seconds.toFixed(1).padStart(7)} s`).join("\n")
}
