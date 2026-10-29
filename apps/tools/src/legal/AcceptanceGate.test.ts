import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { LEGAL_URLS, PRIVACY, TERMS } from "@unleashed/legal"
import type { EIP1193Provider, Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { browserStorage, readAcceptance } from "./acceptance"
import AcceptanceGate from "./AcceptanceGate.vue"
import { GATE_TESTIDS } from "./testids"

const sel = (t: string) => `[data-testid="${t}"]`
const alice = privateKeyToAccount(`0x${"11".repeat(32)}`)
const bob = privateKeyToAccount(`0x${"22".repeat(32)}`)

const LINE = {
	pending:
		"Check your wallet and read the message, then sign or cancel. If no window opened, open your wallet from the browser's toolbar.",
	refused: "You did not sign. Unleashed stays closed until you accept the Terms. You can sign whenever you are ready.",
	busy: "Your wallet already has a request from this page waiting. Open your wallet, sign or cancel it, then try again.",
	noWallet: "No Ethereum wallet found in this browser. Install one, such as Rabby or MetaMask, then reload this page.",
	failed: "Your wallet could not sign this message, or sent back a signature this page cannot check. Try again, or use another account. Some smart-contract accounts cannot sign here yet.",
}

/** A wallet whose `personal_sign` answers are queued: a function signs or throws, `"hold"` waits for `release`. */
function installWallet(...answers: ("sign" | "bob" | "hold" | number)[]) {
	const calls: string[] = []
	let release: () => void = () => {}
	const provider = {
		request: async ({ method, params }: { method: string; params?: unknown }) => {
			calls.push(method)
			if (method === "eth_requestAccounts") return [alice.address]
			const answer = answers.shift() ?? "sign"
			if (typeof answer === "number") throw Object.assign(new Error("wallet error"), { code: answer })
			if (answer === "hold") await new Promise<void>((r) => (release = r))
			const signer = answer === "bob" ? bob : alice
			return signer.signMessage({ message: { raw: (params as [Hex])[0] } })
		},
	} as unknown as EIP1193Provider
	Object.defineProperty(window, "ethereum", { value: provider, configurable: true })
	return { calls, release: () => release() }
}

function gate(reask = false) {
	return mount(AcceptanceGate, { props: { reask }, attachTo: document.body })
}

const status = (w: ReturnType<typeof gate>) => w.find(sel(GATE_TESTIDS.status))
const button = (w: ReturnType<typeof gate>) => w.find(sel(GATE_TESTIDS.sign))

enableAutoUnmount(afterEach)
beforeEach(() => localStorage.clear())
afterEach(() => {
	Reflect.deleteProperty(window, "ethereum")
})

describe("AcceptanceGate", () => {
	it("shows the signed first-visit screen, focused on its heading, with an empty status line", () => {
		const w = gate()
		expect(w.find("h1").text()).toBe("Before you use Unleashed")
		expect(document.activeElement).toBe(w.find("h1").element)
		const body = w.findAll("p.body").map((p) => p.text().replace(/\s+/g, " "))
		expect(body).toEqual([
			"Unleashed is experimental software. Its operator never takes custody of your funds or keys, and cannot reverse a transaction you send.",
			"To continue, sign a message with your Ethereum wallet. It says you agree to the Terms of Use and have read the Privacy Policy. Signing is free and sends no transaction.",
		])
		expect(button(w).text()).toBe("Sign with your wallet")
		expect(w.find(".hint").text()).toBe("Your wallet may ask you to connect to this site first.")
		expect(status(w).attributes("role")).toBe("status")
		expect(status(w).text()).toBe("")
	})

	it("links both documents on the landing, safely, with their dates", () => {
		const links = gate().findAll(sel(GATE_TESTIDS.docLink))
		expect(links.map((l) => l.text())).toEqual(["Terms of Use", "Privacy Policy"])
		expect(links.map((l) => l.attributes("href"))).toEqual([LEGAL_URLS[TERMS.id], LEGAL_URLS[PRIVACY.id]])
		for (const l of links) expect([l.attributes("target"), l.attributes("rel")]).toEqual(["_blank", "noopener noreferrer"])
		expect(
			gate()
				.findAll(".date")
				.map((d) => d.text()),
		).toEqual([`updated ${TERMS.updated}`, `updated ${PRIVACY.updated}`])
	})

	it("shows the signed re-ask heading and paragraph, without the first-visit paragraphs", () => {
		const w = gate(true)
		expect(w.find("h1").text()).toBe("The Terms or the Privacy Policy changed")
		expect(w.findAll("p.body").map((p) => p.text())).toEqual([
			"One or both have a new version. Read them, then sign to keep using Unleashed.",
		])
		expect(button(w).text()).toBe("Sign with your wallet")
	})

	it("asks the wallet nothing before the press; the press holds as pending, then accepts and stores", async () => {
		const wallet = installWallet("hold")
		const w = gate()
		await flushPromises()
		expect(wallet.calls).toEqual([])
		await button(w).trigger("click")
		await flushPromises()
		expect(button(w).text()).toBe("Waiting for your wallet…")
		expect(button(w).attributes("disabled")).toBeDefined()
		expect(button(w).attributes("aria-busy")).toBe("true")
		expect(status(w).text()).toBe(LINE.pending)
		await button(w).trigger("click")
		wallet.release()
		await flushPromises()
		expect(wallet.calls).toEqual(["eth_requestAccounts", "personal_sign"])
		expect(w.emitted("accepted")).toHaveLength(1)
		expect(await readAcceptance(browserStorage, window.location.origin)).toBe("accepted")
	})

	it("says what went wrong and keeps the button for a retry", async () => {
		installWallet(4001, "sign")
		const w = gate()
		await button(w).trigger("click")
		await flushPromises()
		expect(status(w).text()).toBe(LINE.refused)
		expect(status(w).classes()).not.toContain("warn")
		expect(button(w).attributes("disabled")).toBeUndefined()
		expect(w.emitted("accepted")).toBeUndefined()
		await button(w).trigger("click")
		await flushPromises()
		expect(w.emitted("accepted")).toHaveLength(1)
	})

	it.each([
		[-32002, LINE.busy],
		["bob", LINE.failed],
	] as const)("shows the warning line for a %s answer, storing nothing", async (answer, line) => {
		installWallet(answer)
		const w = gate()
		await button(w).trigger("click")
		await flushPromises()
		expect(status(w).text()).toBe(line)
		expect(status(w).classes()).toContain("warn")
		expect(w.emitted("accepted")).toBeUndefined()
		expect(localStorage.length).toBe(0)
	})

	it("says so when the browser has no Ethereum wallet", async () => {
		const w = gate()
		await button(w).trigger("click")
		await flushPromises()
		expect(status(w).text()).toBe(LINE.noWallet)
		expect(status(w).classes()).toContain("warn")
	})

	it("signs from a native button in the tab order (the browser run presses it by keyboard)", () => {
		const el = button(gate()).element as HTMLButtonElement
		expect(el.tagName).toBe("BUTTON")
		expect(el.type).toBe("button")
		expect(el.tabIndex).toBe(0)
	})
})
