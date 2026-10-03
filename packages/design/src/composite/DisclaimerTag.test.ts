import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import { ICONS } from "../core/icons"
import DisclaimerTag from "./DisclaimerTag.vue"

describe("DisclaimerTag", () => {
	it("renders the canonical 'Test token · no real value' text", () => {
		const w = mount(DisclaimerTag)
		expect(w.text()).toBe("Test token · no real value")
	})

	it("is a neutral Tag carrying the info icon", () => {
		const w = mount(DisclaimerTag)
		expect(w.get(".tag").classes()).toContain("tag--neutral")
		expect(w.findAll("path").map((p) => p.attributes("d"))).toEqual([...ICONS["info-box"].d])
	})

	it("renders inside a single tag element", () => {
		const w = mount(DisclaimerTag)
		expect(w.findAll(".tag")).toHaveLength(1)
	})

	it("does not provide any interactive surface", () => {
		const w = mount(DisclaimerTag)
		expect(w.find("button").exists()).toBe(false)
		expect(w.find("a").exists()).toBe(false)
	})

	it("is stable across re-renders (same html, same dom)", () => {
		const a = mount(DisclaimerTag)
		const b = mount(DisclaimerTag)
		expect(a.html()).toBe(b.html())
	})
})
