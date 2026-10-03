import { describe, expect, it } from "vitest"
import { flowGasOnly, flowNoRoute, flowTokenPlusGas } from "../../scripts/sandbox/flows"
import {
	flowGasOnlyPrivate,
	flowGasOnlySwapped,
	flowGasOnlyWethSingleHop,
	flowMinFuelFloorBinds,
	flowTokenPlusGasPrivate,
	flowTokenPlusGasWithCreditHeld,
} from "../../scripts/sandbox/flows-matrix"
import { freshActor, INTEGRATION, sandbox } from "./sandbox"

describe.skipIf(!INTEGRATION)("the gas leg", () => {
	it("token + gas, public: the claim pays for itself with the fuel the send bridged (cell 13)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowTokenPlusGas(a.s, usdt, await a.l2TokenOf(usdt))).toContain("paid for itself")
	})

	it("token + gas, public, leaves held private credit untouched (cell 14)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowTokenPlusGasWithCreditHeld(a.s, usdt, await a.l2TokenOf(usdt))).toContain("untouched")
	})

	it("token + gas, private: the PrivateFPC pays the claim from the fuel (cell 15)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowTokenPlusGasPrivate(a.s, usdt, a.s.l2TokenOf)).toContain("claim privately")
	})

	it("token + gas, private, first-time token: registration then credit (cell 16)", async () => {
		const a = await freshActor()
		expect(await flowTokenPlusGasPrivate(a.s, undefined, a.s.l2TokenOf)).toContain("register,claim privately")
	})

	it("a floor above the venue's output is refused at settlement (cell 17)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowMinFuelFloorBinds(a.s, usdt)).toContain("reverted on the floor")
	})

	it("gas only through the fee asset's identity route, public (cell 18)", async () => {
		const a = await freshActor()
		expect(await flowGasOnly(a.s)).toContain("claimed as fee juice")
	})

	it("gas only, private credit at the PrivateFPC (cell 19)", async () => {
		const a = await freshActor()
		expect(await flowGasOnlyPrivate(a.s)).toContain("private gas")
	})

	it("gas only through a swapped token, public (cell 20)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowGasOnlySwapped(a.s, usdt)).toContain("public gas")
	})

	it("gas only through a swapped token, private credit (cell 20)", async () => {
		const a = await freshActor()
		const { usdt } = await sandbox()
		expect(await flowGasOnlySwapped(a.s, usdt, true)).toContain("private gas")
	})

	it("a WETH deposit discovers and settles the single-hop route, public (cell 21)", async () => {
		const a = await freshActor()
		expect(await flowGasOnlyWethSingleHop(a.s)).toContain("single-hop")
	})

	it("a WETH deposit discovers and settles the single-hop route, private credit (cell 21)", async () => {
		const a = await freshActor()
		expect(await flowGasOnlyWethSingleHop(a.s, true)).toContain("private gas")
	})

	it("a routeless token is refused before anything is signed (cell 22)", async () => {
		const a = await freshActor()
		const { clients } = await sandbox()
		expect(await flowNoRoute(a.s, clients.deployment.tokens.nort)).toContain("no-route")
	})
})
