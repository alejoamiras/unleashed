import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

// Read the raw stylesheets via fs — `?raw` imports return empty under the tools app's jsdom vitest (the
// vue/css pipeline swallows them). The design package is always at `packages/design` in this monorepo.
const here = dirname(fileURLToPath(import.meta.url)) // apps/tools/src
const appCss = readFileSync(join(here, "app.css"), "utf8")
const baseCss = readFileSync(join(here, "../../../packages/design/src/base.css"), "utf8")

/**
 * The element-global rules the tools app needs must exist somewhere in `app.css ∪ base.css`: a
 * missing rule changes no token, so no token test sees it. Presence only, not cascade: jsdom cannot
 * resolve the cascade, and the check assumes `main.ts` imports `app.css` after `base.css`.
 */
const css = `${baseCss}\n${appCss}`.replace(/\s+/g, " ")

// [label, regex] — each rule-group must co-occur (selector … { … property) somewhere in the union.
const REQUIRED: Array<[string, RegExp]> = [
	["page background (html/body)", /(html|body)[^{]*\{[^}]*background/],
	["page text color (html/body)", /(html|body)[^{]*\{[^}]*[^-]color\s*:/],
	["page min-height (html/body)", /(html|body)[^{]*\{[^}]*min-height/],
	["button cursor reset", /button[^{]*\{[^}]*cursor/],
	["disabled button cursor", /button:disabled[^{]*\{[^}]*cursor/],
	["input color inherit", /input[^{]*\{[^}]*color/],
	["focus-visible outline", /focus-visible[^{]*\{[^}]*outline/],
]

describe("tools host-rule parity (missing-rule guard over app.css ∪ @unleashed/design/base.css)", () => {
	for (const [label, re] of REQUIRED) {
		test(`host rule present: ${label}`, () => {
			expect(re.test(css), `missing host rule "${label}" — restore it in app.css or @unleashed/design/base.css`).toBe(true)
		})
	}
})
