/**
 * Nothing leaves the machine. Every request that is not loopback is aborted and recorded; the one
 * remote the app fetches on its own — the community token list — is answered from a fixture. A
 * test asserts the record is empty at the end, so a new remote dependency fails loudly here.
 */
import { readFileSync } from "node:fs"
import type { BrowserContext } from "@playwright/test"
import { TOKEN_LIST_URL } from "@unleashed/bridge-core"

/** Which fixture answers the community token list: the well-formed one, or one with hostile entries. */
export type TokenListFixture = "community" | "hostile"

const TOKEN_LIST_FIXTURES: Record<TokenListFixture, URL> = {
	community: new URL("../../e2e/fixtures/token-list.json", import.meta.url),
	hostile: new URL("../../e2e/fixtures/token-list-hostile.json", import.meta.url),
}

export interface Egress {
	/** URLs of every non-loopback request the context attempted, in order. */
	readonly blocked: string[]
}

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]"

export async function confineEgress(context: BrowserContext, fixture: TokenListFixture = "community"): Promise<Egress> {
	const blocked: string[] = []
	const tokenList = readFileSync(TOKEN_LIST_FIXTURES[fixture], "utf8")
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url())
		if (url.href === TOKEN_LIST_URL) return route.fulfill({ status: 200, contentType: "application/json", body: tokenList })
		if (isLoopback(url.hostname)) return route.continue()
		blocked.push(url.href)
		return route.abort("blockedbyclient")
	})
	return { blocked }
}
