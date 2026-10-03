import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { IconName } from "../core/Icon.vue"
import { ICONS } from "../core/icons"
import Tag from "./Tag.vue"

const drawn = (w: ReturnType<typeof mount>) => w.findAll("path").map((p) => p.attributes("d"))
const glyph = (name: Exclude<IconName, "chevron">) => [...ICONS[name].d]

describe("Tag", () => {
	it("renders slot content and forwards data-testid to the root", () => {
		const w = mount(Tag, { attrs: { "data-testid": "fa-tag-disclaimer" }, slots: { default: "Test token" } })
		expect(w.text()).toBe("Test token")
		expect(w.get(".tag").attributes("data-testid")).toBe("fa-tag-disclaimer")
	})

	it.each([
		[undefined, "tag--neutral", null],
		["ink", "tag--ink", null],
		["testnet", "tag--testnet", null],
		["warn", "tag--warn", "warning-diamond"],
		["lost", "tag--lost", "square-alert"],
		["carrier", "tag--carrier", "check"],
		["private", "tag--private", "eye-off"],
		["other", "tag--other", "wallet"],
	] as const)("tone %s → %s with default icon %s", (tone, cls, icon) => {
		const w = mount(Tag, { props: { tone }, slots: { default: "x" } })
		expect(w.get(".tag").classes()).toContain(cls)
		expect(w.findAll("svg")).toHaveLength(icon ? 1 : 0)
		if (icon) expect(drawn(w)).toEqual(glyph(icon))
	})

	it("an icon replaces the tone's default, and null drops it", () => {
		const publicTag = mount(Tag, { props: { icon: "eye" }, slots: { default: "Public" } })
		expect(drawn(publicTag)).toEqual(glyph("eye"))
		const bare = mount(Tag, { props: { tone: "warn", icon: null }, slots: { default: "x" } })
		expect(bare.find("svg").exists()).toBe(false)
	})

	it("small adds the card-chip size class; the default size has none", () => {
		expect(mount(Tag, { props: { size: "small" } }).classes()).toContain("tag--small")
		expect(mount(Tag).classes()).not.toContain("tag--small")
	})
})
