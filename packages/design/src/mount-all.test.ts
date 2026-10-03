import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { Component } from "vue"
import Flex from "./core/Flex.vue"
import Icon from "./core/Icon.vue"
import Button from "./ui/Button.vue"
import BusyPixels from "./ui/BusyPixels.vue"
import Dialog from "./ui/Dialog.vue"
import ProgressBar from "./ui/ProgressBar.vue"

/**
 * Every SFC mounts with explicit imports: neither the package nor the tools app has auto-import, and
 * a missing import surfaces only as a "failed to resolve component" warning or a runtime throw.
 */
const cases: Array<[string, Component, Record<string, unknown>]> = [
	["Flex", Flex, {}],
	["Icon", Icon, { name: "chevron" }],
	["Icon 12, coloured", Icon, { name: "check", size: 12, color: "tertiary" }],
	['Icon "24", rotated', Icon, { name: "chevron-down", size: "24", rotate: "90" }],
	["Icon 24, labelled", Icon, { name: "external-link", size: 24, label: "Opens in a new tab" }],
	["BusyPixels", BusyPixels, {}],
	["Button", Button, {}],
	["Dialog", Dialog, { open: true, title: "Verify the grid" }],
	["ProgressBar", ProgressBar, { label: "Drip progress" }],
]

describe("@unleashed/design components mount without auto-import", () => {
	let warn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})
	afterEach(() => warn.mockRestore())

	for (const [name, Comp, props] of cases) {
		test(`${name} mounts clean (no unresolved-component warning, no throw)`, () => {
			expect(() => mount(Comp, { props })).not.toThrow()
			const resolveWarnings = warn.mock.calls
				.flat()
				.filter((arg: unknown) => typeof arg === "string" && /resolve component|Failed to resolve/i.test(arg))
			expect(resolveWarnings).toEqual([])
		})
	}
})
