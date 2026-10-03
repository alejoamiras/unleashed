import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import BalanceRow from "./BalanceRow.vue"

// Literal testids — the component takes them as props (no app registry).
// Numeric formatting is covered by the app's formatBigInt unit tests; this
// component is presentational and only renders the strings it's given.
const pubId = "fa-balance-public"
const privId = "fa-balance-private"

describe("BalanceRow", () => {
	it("labels the rows Public and Private, each with one glyph", () => {
		const rows = mount(BalanceRow, { props: { publicText: "0.00", privateText: "0.00" } }).findAll(".row")
		expect(rows.map((r) => r.get(".label").text())).toEqual(["Public", "Private"])
		for (const r of rows) expect(r.findAll("svg")).toHaveLength(1)
	})

	it("renders the passed public + private text", () => {
		const w = mount(BalanceRow, {
			props: { publicText: "1,000.00", privateText: "0.05", publicTestId: pubId, privateTestId: privId },
		})
		expect(w.get(`[data-testid="${pubId}"]`).text()).toBe("1,000.00")
		expect(w.get(`[data-testid="${privId}"]`).text()).toBe("0.05")
	})

	it("renders placeholder text verbatim (— / …)", () => {
		const w = mount(BalanceRow, {
			props: { publicText: "—", privateText: "…", publicTestId: pubId, privateTestId: privId },
		})
		expect(w.get(`[data-testid="${pubId}"]`).text()).toBe("—")
		expect(w.get(`[data-testid="${privId}"]`).text()).toBe("…")
	})

	it("applies the testids via props", () => {
		const w = mount(BalanceRow, {
			props: { publicText: "0.00", privateText: "0.00", publicTestId: pubId, privateTestId: privId },
		})
		expect(w.find(`[data-testid="${pubId}"]`).exists()).toBe(true)
		expect(w.find(`[data-testid="${privId}"]`).exists()).toBe(true)
	})

	it("omits the value testid when not provided", () => {
		const w = mount(BalanceRow, { props: { publicText: "0.00", privateText: "0.00" } })
		expect(w.find("[data-testid]").exists()).toBe(false)
	})

	it("renders public first, private second", () => {
		const values = mount(BalanceRow, {
			props: { publicText: "PUB", privateText: "PRIV", publicTestId: pubId, privateTestId: privId },
		}).findAll(".value")
		expect(values.map((v) => v.text())).toEqual(["PUB", "PRIV"])
	})

	it("reacts to text prop changes", async () => {
		const w = mount(BalanceRow, { props: { publicText: "0.00", privateText: "0.00", publicTestId: pubId } })
		await w.setProps({ publicText: "5.00" })
		expect(w.get(`[data-testid="${pubId}"]`).text()).toBe("5.00")
	})
})
