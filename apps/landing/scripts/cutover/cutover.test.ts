import { describe, expect, test } from "vitest"
import { CfApiError, cloudflare } from "./api.ts"
import { redirectEntrypoint } from "./inventory.ts"
import { landingRedirects, type RedirectRule } from "./rules.ts"

const TOKEN = "t0ken-value-that-must-never-leak"

function rule(id: string, expression: string, target: string): RedirectRule {
	return { id, action: "redirect", enabled: true, expression, action_parameters: { from_value: { target_url: { value: target } } } }
}

test("only the rules that send a landing host to the app are the cutover's", () => {
	const rules = [
		rule(
			"apex",
			'(http.host eq "unleashed.systems") or (http.host eq "www.unleashed.systems")',
			"https://testnet.app.unleashed.systems/",
		),
		rule("www", 'http.request.full_uri wildcard "https://www.unleashed.systems/*"', "https://testnet.app.unleashed.systems"),
		rule("other-host", 'http.host eq "docs.unleashed.systems"', "https://testnet.app.unleashed.systems/"),
		rule("other-target", 'http.host eq "unleashed.systems"', "https://testnet.app.unleashed.systems.evil.example/"),
		rule("subdomain-only", 'http.host eq "x.www.unleashed.systems"', "https://testnet.app.unleashed.systems/"),
	]
	expect(landingRedirects(rules).map((r) => r.id)).toEqual(["apex", "www"])
})

describe("the API client", () => {
	function answering(status: number, body: string) {
		const seen: Headers[] = []
		const fetcher = (async (_url: string, init: RequestInit) => {
			seen.push(new Headers(init.headers))
			return new Response(body, { status })
		}) as unknown as typeof fetch
		return { api: cloudflare(TOKEN, fetcher), seen }
	}

	test("sends the token as a bearer header and keeps it out of errors", async () => {
		const { api, seen } = answering(403, JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }))
		const error = await api.call("GET", "/zones?name=unleashed.systems").catch((e: unknown) => e)
		expect(seen[0]?.get("authorization")).toBe(`Bearer ${TOKEN}`)
		expect(error).toBeInstanceOf(CfApiError)
		expect(String(error)).toContain("10000 Authentication error")
		expect(String(error)).not.toContain(TOKEN)
	})

	test("an empty redirect phase reads as null, any other failure throws", async () => {
		expect(await redirectEntrypoint(answering(404, JSON.stringify({ success: false, errors: [] })).api, "z")).toBeNull()
		await expect(redirectEntrypoint(answering(403, "<html>").api, "z")).rejects.toThrow("response is not JSON")
	})
})
