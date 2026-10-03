import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { STANDARD_AUTH_REGISTRY_ADDRESS } from "@aztec-labs/standard-contracts/auth-registry/constants"
import { describe, expect, it } from "vitest"
import { type AppManifest, buildCombinedManifest, buildDripManifest, buildSendManifest } from "./capabilities"

const DRIPPER = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000001")
const USDC = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000002")
const ETH = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000003")
const SPONSORED_FPC = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000004")

import { PRIVATE_FPC_ADDRESS, feeJuiceAddress } from "@unleashed/bridge-core"

describe("buildDripManifest", () => {
	const m = buildDripManifest({
		dripperAddress: DRIPPER,
		usdcAddress: USDC,
		ethAddress: ETH,
		sponsoredFpcAddress: SPONSORED_FPC,
		appUrl: "https://faucet.test",
	})

	it("populates metadata with the dApp identity and url", () => {
		expect(m.metadata.name).toBe("unleashed")
		expect(m.metadata.version).toBe("0.1.0")
		expect(m.metadata.url).toBe("https://faucet.test")
	})

	it("requests accounts with canGet=true and canCreateAuthWit=false (no authwit needed)", () => {
		const cap = m.capabilities.find((c) => c.type === "accounts")
		expect(cap).toEqual({ type: "accounts", canGet: true, canCreateAuthWit: false })
	})

	it("declares contracts scope = [DRIPPER, USDC, ETH] only - no SponsoredFPC", () => {
		const cap = m.capabilities.find((c) => c.type === "contracts")
		if (cap?.type !== "contracts") throw new Error("contracts cap missing")
		const addrs = cap.contracts.map((a) => a.toString())
		expect(addrs).toEqual([DRIPPER.toString(), USDC.toString(), ETH.toString()])
		expect(cap.canRegister).toBe(true)
	})

	it("declares simulation.utilities.scope = balance_of_private only (utility functions)", () => {
		const cap = m.capabilities.find((c) => c.type === "simulation")
		if (cap?.type !== "simulation") throw new Error("simulation cap missing")
		const scopes = cap.utilities.scope.map((s) => `${s.contract.toString()}::${s.function}`)
		expect(scopes).toEqual([`${USDC.toString()}::balance_of_private`, `${ETH.toString()}::balance_of_private`])
	})

	it("declares simulation.transactions.scope = balance_of_public only (public views)", () => {
		const cap = m.capabilities.find((c) => c.type === "simulation")
		if (cap?.type !== "simulation") throw new Error("simulation cap missing")
		const scopes = cap.transactions.scope.map((s) => `${s.contract.toString()}::${s.function}`)
		expect(scopes).toEqual([`${USDC.toString()}::balance_of_public`, `${ETH.toString()}::balance_of_public`])
	})

	it("declares transaction scope = drip_to_public + drip_to_private + sponsor_unconditionally", () => {
		const cap = m.capabilities.find((c) => c.type === "transaction")
		if (cap?.type !== "transaction") throw new Error("transaction cap missing")
		expect(cap.scope).toEqual([
			{ contract: DRIPPER, function: "drip_to_public" },
			{ contract: DRIPPER, function: "drip_to_private" },
			{ contract: SPONSORED_FPC, function: "sponsor_unconditionally" },
		])
	})

	it("includes the sponsor_unconditionally entry so Nulo's per-call scope check passes", () => {
		const cap = m.capabilities.find((c) => c.type === "transaction")
		if (cap?.type !== "transaction") throw new Error("transaction cap missing")
		const sponsorEntry = cap.scope.find((s) => s.function === "sponsor_unconditionally")
		expect(sponsorEntry?.contract.toString()).toBe(SPONSORED_FPC.toString())
	})
})

const HUB = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000007")
const TOKEN_A = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000008")
const TOKEN_B = AztecAddress.fromStringUnsafe("0x0000000000000000000000000000000000000000000000000000000000000009")
const AUTH_REGISTRY = STANDARD_AUTH_REGISTRY_ADDRESS.toString()

type Scoped = { contract: { toString(): string }; function: string }
const label = (s: Scoped) => `${s.contract.toString()}::${s.function}`

function scopes(m: AppManifest) {
	const contracts = m.capabilities.find((c) => c.type === "contracts")
	const simulation = m.capabilities.find((c) => c.type === "simulation")
	const transaction = m.capabilities.find((c) => c.type === "transaction")
	if (contracts?.type !== "contracts" || simulation?.type !== "simulation" || transaction?.type !== "transaction") {
		throw new Error("manifest is missing a capability")
	}
	return {
		contracts: contracts.contracts.map((a) => a.toString()),
		utilities: simulation.utilities.scope.map(label),
		simulated: simulation.transactions.scope.map(label),
		transactions: transaction.scope.map(label),
	}
}

/** The send half, verbatim — one hub + N Tokens. Every builder that emits it is pinned against this. */
function expectedSendScopes(tokens: AztecAddress[]) {
	const t = tokens.map((a) => a.toString())
	const hub = HUB.toString()
	return {
		contracts: [hub, ...t, PRIVATE_FPC_ADDRESS],
		utilities: [...t.map((a) => `${a}::balance_of_private`), `${PRIVATE_FPC_ADDRESS}::balance_of`],
		simulated: [
			...t.map((a) => `${a}::balance_of_public`),
			`${hub}::token_for`,
			`${hub}::portal_for`,
			`${hub}::exits_paused`,
			`${hub}::claim_public`,
			`${hub}::claim_private`,
			`${hub}::exit_to_l1_public`,
			`${hub}::exit_to_l1_private`,
			...t.flatMap((a) => [`${a}::burn_public`, `${a}::burn_private`]),
			`${AUTH_REGISTRY}::set_authorized`,
			`${feeJuiceAddress}::claim_and_end_setup`,
			`${feeJuiceAddress}::claim`,
			`${PRIVATE_FPC_ADDRESS}::mint_and_pay_fee`,
			`${PRIVATE_FPC_ADDRESS}::pay_fee`,
			`${feeJuiceAddress}::balance_of_public`,
		],
		transactions: [
			`${feeJuiceAddress}::claim_and_end_setup`,
			`${feeJuiceAddress}::claim`,
			`${PRIVATE_FPC_ADDRESS}::mint_and_pay_fee`,
			`${PRIVATE_FPC_ADDRESS}::pay_fee`,
			`${hub}::register_token`,
			`${hub}::register_and_claim_public`,
			`${hub}::claim_public`,
			`${hub}::claim_private`,
			`${hub}::exit_to_l1_public`,
			`${hub}::exit_to_l1_private`,
			...t.flatMap((a) => [`${a}::burn_public`, `${a}::burn_private`]),
			`${AUTH_REGISTRY}::set_authorized`,
		],
	}
}

describe("buildSendManifest", () => {
	const m = buildSendManifest({ hub: HUB, tokens: [TOKEN_A], appUrl: "https://send.test" })

	it("metadata identifies the bridge dApp", () => {
		expect(m.metadata.name).toBe("unleashed-bridge")
		expect(m.metadata.url).toBe("https://send.test")
	})

	it("requests canCreateAuthWit=true (an exit needs a burn auth-wit)", () => {
		expect(m.capabilities.find((c) => c.type === "accounts")).toEqual({ type: "accounts", canGet: true, canCreateAuthWit: true })
	})

	it("emits the send scopes verbatim for one token", () => {
		expect(scopes(m)).toEqual(expectedSendScopes([TOKEN_A]))
	})

	it("emits per-token burns and balance reads for EVERY granted token", () => {
		const two = buildSendManifest({ hub: HUB, tokens: [TOKEN_A, TOKEN_B] })
		expect(scopes(two)).toEqual(expectedSendScopes([TOKEN_A, TOKEN_B]))
	})

	it("grants registration + both claims + both exits on the hub, and simulates everything but the registrations", () => {
		const s = scopes(m)
		const hub = HUB.toString()
		expect(s.transactions).toContain(`${hub}::register_token`)
		expect(s.transactions).toContain(`${hub}::register_and_claim_public`)
		// An instance the PXE has not seen cannot be simulated, so a registration is send-only.
		expect(s.simulated).not.toContain(`${hub}::register_token`)
		expect(s.simulated).not.toContain(`${hub}::register_and_claim_public`)
	})

	it("does NOT grant the guardian's pause switch", () => {
		const s = scopes(m)
		expect([...s.transactions, ...s.simulated, ...s.utilities].filter((e) => e.includes("set_exits_paused"))).toEqual([])
	})

	it("uses exact addresses everywhere - no wildcard contract or function", () => {
		const s = scopes(m)
		expect([...s.contracts, ...s.utilities, ...s.simulated, ...s.transactions].filter((e) => e.includes("*"))).toEqual([])
	})

	describe("placeholder network (no hub)", () => {
		const p = buildSendManifest({ tokens: [TOKEN_A, TOKEN_B] })

		it("emits no hub scopes and no token scopes at all", () => {
			const s = scopes(p)
			const named = [...s.contracts, ...s.utilities, ...s.simulated, ...s.transactions].join("|")
			expect(named).not.toContain(HUB.toString())
			expect(named).not.toContain(TOKEN_A.toString())
			expect(named).not.toContain(TOKEN_B.toString())
		})

		it("keeps the fee machinery so fuel still works", () => {
			const s = scopes(p)
			expect(s.contracts).toEqual([PRIVATE_FPC_ADDRESS])
			expect(s.utilities).toEqual([`${PRIVATE_FPC_ADDRESS}::balance_of`])
			expect(s.transactions).toEqual([
				`${feeJuiceAddress}::claim_and_end_setup`,
				`${feeJuiceAddress}::claim`,
				`${PRIVATE_FPC_ADDRESS}::mint_and_pay_fee`,
				`${PRIVATE_FPC_ADDRESS}::pay_fee`,
				`${AUTH_REGISTRY}::set_authorized`,
			])
		})
	})
})

describe("buildCombinedManifest", () => {
	const faucetInput = {
		dripperAddress: DRIPPER,
		usdcAddress: USDC,
		ethAddress: ETH,
		sponsoredFpcAddress: SPONSORED_FPC,
	}
	const m = buildCombinedManifest({ ...faucetInput, hub: HUB, hubTokens: [TOKEN_A, TOKEN_B], appUrl: "https://app.test" })

	/** The faucet half, unchanged by the wizard's arrival. */
	const faucetPrefix = {
		contracts: [DRIPPER.toString(), USDC.toString(), ETH.toString()],
		utilities: [`${USDC.toString()}::balance_of_private`, `${ETH.toString()}::balance_of_private`],
		// The sponsor travels with the faucet, the one surface it pays for; the send scopes carry none.
		simulated: [
			`${USDC.toString()}::balance_of_public`,
			`${ETH.toString()}::balance_of_public`,
			`${SPONSORED_FPC.toString()}::sponsor_unconditionally`,
		],
		transactions: [
			`${DRIPPER.toString()}::drip_to_public`,
			`${DRIPPER.toString()}::drip_to_private`,
			`${SPONSORED_FPC.toString()}::sponsor_unconditionally`,
		],
	}

	it("requests canCreateAuthWit=true (the exit needs a burn auth-wit)", () => {
		expect(m.capabilities.find((c) => c.type === "accounts")).toEqual({ type: "accounts", canGet: true, canCreateAuthWit: true })
	})

	it("is the send scopes plus the faucet's, with the faucet reads first and its contracts last", () => {
		const send = expectedSendScopes([TOKEN_A, TOKEN_B])
		expect(scopes(m)).toEqual({
			contracts: [...send.contracts, ...faucetPrefix.contracts],
			utilities: [...faucetPrefix.utilities, ...send.utilities],
			simulated: [...faucetPrefix.simulated, ...send.simulated],
			transactions: [...faucetPrefix.transactions, ...send.transactions],
		})
	})

	// The mainnet shape: omit the faucet tokens, but the PrivateFPC + FEE_JUICE + auth-registry scopes
	// MUST stay so private fuel and private-fuel-paid claims work and the unconditional FPC
	// registration doesn't hit a scope violation.
	describe("mainnet shape (no faucet tokens)", () => {
		const mm = buildCombinedManifest({ hub: HUB, hubTokens: [TOKEN_A], sponsoredFpcAddress: SPONSORED_FPC })

		it("grants hub + token + PrivateFPC and NO faucet tokens", () => {
			expect(scopes(mm).contracts).toEqual([HUB.toString(), TOKEN_A.toString(), PRIVATE_FPC_ADDRESS])
		})

		it("keeps the private-fuel scopes (mint_and_pay_fee, pay_fee) and drops the faucet drips", () => {
			const fns = scopes(mm).transactions
			expect(fns).toContain(`${PRIVATE_FPC_ADDRESS}::mint_and_pay_fee`)
			expect(fns).toContain(`${PRIVATE_FPC_ADDRESS}::pay_fee`)
			expect(fns.some((f) => f.includes("drip_to_"))).toBe(false)
		})
	})

	describe("placeholder network", () => {
		const p = buildCombinedManifest({ ...faucetInput, hubTokens: [TOKEN_A] })

		it("keeps the faucet half and emits nothing for the hub or its tokens", () => {
			const s = scopes(p)
			expect(s.contracts).toEqual([PRIVATE_FPC_ADDRESS, ...faucetPrefix.contracts])
			expect(s.transactions.some((f) => f.includes(HUB.toString()) || f.includes(TOKEN_A.toString()))).toBe(false)
		})
	})
})

describe("fuel claim scope (canonical FeeJuice)", () => {
	const sendInput = { hub: HUB, tokens: [TOKEN_A] }
	const combinedInput = {
		dripperAddress: DRIPPER,
		usdcAddress: USDC,
		ethAddress: ETH,
		sponsoredFpcAddress: SPONSORED_FPC,
		hub: HUB,
		hubTokens: [TOKEN_A],
	}

	it("scopes the FJ claim for BOTH send and simulate (the fjwc dry-run) in either builder", () => {
		for (const m of [buildSendManifest(sendInput), buildCombinedManifest(combinedInput)]) {
			const s = scopes(m)
			expect(s.transactions).toContain(`${feeJuiceAddress}::claim_and_end_setup`)
			expect(s.simulated).toContain(`${feeJuiceAddress}::claim_and_end_setup`)
		}
	})

	it("scopes private fuel (FeeJuice.claim + mint_and_pay_fee) for send AND simulate", () => {
		const s = scopes(buildCombinedManifest(combinedInput))
		for (const list of [s.transactions, s.simulated]) {
			expect(list).toContain(`${feeJuiceAddress}::claim`)
			expect(list).toContain(`${PRIVATE_FPC_ADDRESS}::mint_and_pay_fee`)
		}
	})

	it("includes the PrivateFPC in contracts (pre-registered for the no-fuel private-FJ read under 5.0.1)", () => {
		// The wallet only auto-registers the FPC when a tx USES it as fee payer; the no-fuel claim gate
		// reads its balance_of BEFORE that, and 5.0.1's registerContract conformance (dev #288) stops the
		// read's on-the-fly Contract.at() from registering the artifact — so the faucet pre-registers it.
		expect(scopes(buildCombinedManifest(combinedInput)).contracts).toContain(PRIVATE_FPC_ADDRESS)
	})

	it("scopes PrivateFPC.balance_of for the no-fuel private-FJ read (utilities only — it is abi_utility)", () => {
		const s = scopes(buildCombinedManifest(combinedInput))
		const entry = `${PRIVATE_FPC_ADDRESS}::balance_of`
		expect(s.utilities).toContain(entry)
		// It is a utility read — NOT a tx-shaped simulation NOR a send.
		expect(s.simulated).not.toContain(entry)
		expect(s.transactions).not.toContain(entry)
	})

	it("scopes FeeJuice.balance_of_public for the no-fuel cold-check (simulate only)", () => {
		const s = scopes(buildCombinedManifest(combinedInput))
		expect(s.simulated).toContain(`${feeJuiceAddress}::balance_of_public`)
		expect(s.transactions).not.toContain(`${feeJuiceAddress}::balance_of_public`)
	})

	it("the FJ entries are exactly the claim pair plus the read - no wildcards", () => {
		const s = scopes(buildSendManifest(sendInput))
		expect(s.transactions.filter((e) => e.startsWith(feeJuiceAddress))).toEqual([
			`${feeJuiceAddress}::claim_and_end_setup`,
			`${feeJuiceAddress}::claim`,
		])
	})
})
