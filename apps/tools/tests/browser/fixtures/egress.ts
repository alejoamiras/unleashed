/**
 * Nothing leaves the machine. Every request that is not loopback is aborted and recorded; the
 * remotes the app fetches on its own — the community token list, and li.quest's gas quote where a
 * file asks for it — are answered from fixtures. A test asserts the record is empty at the end, so a
 * new remote dependency fails loudly here.
 */
import { readFileSync } from "node:fs"
import type { BrowserContext } from "@playwright/test"
import { TOKEN_LIST_URL } from "@unleashed/bridge-core"
import { LI_QUEST_API } from "@unleashed/sdk/protocol"

/** Which fixture answers the community token list: the well-formed one, or one with hostile entries. */
export type TokenListFixture = "community" | "hostile"

const TOKEN_LIST_FIXTURES: Record<TokenListFixture, URL> = {
	community: new URL("../../e2e/fixtures/token-list.json", import.meta.url),
	hostile: new URL("../../e2e/fixtures/token-list-hostile.json", import.meta.url),
}

export interface Egress {
	/** URLs of every non-loopback request the context attempted, in order. */
	readonly blocked: string[]
	/** The li.quest quotes answered, in order. */
	readonly quoted: string[]
}

/** Answers li.quest's `GET /v1/quote`; without one, a quote request is blocked like any other remote. */
export type LifiQuoteAnswer = (url: URL) => Promise<{ status: number; body: unknown }>

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]"
const LI_QUEST_QUOTE = `${LI_QUEST_API}/quote`

export async function confineEgress(
	context: BrowserContext,
	fixture: TokenListFixture = "community",
	lifiQuote?: LifiQuoteAnswer,
): Promise<Egress> {
	const blocked: string[] = []
	const quoted: string[] = []
	const tokenList = readFileSync(TOKEN_LIST_FIXTURES[fixture], "utf8")
	await context.route("**/*", async (route) => {
		const url = new URL(route.request().url())
		if (url.href === TOKEN_LIST_URL) return route.fulfill({ status: 200, contentType: "application/json", body: tokenList })
		if (lifiQuote && `${url.origin}${url.pathname}` === LI_QUEST_QUOTE) {
			quoted.push(url.href)
			const { status, body } = await lifiQuote(url)
			// A cross-origin read under COEP: the page sees the body only with CORS's consent.
			const headers = { "access-control-allow-origin": "*" }
			return route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) })
		}
		if (isLoopback(url.hostname)) return route.continue()
		blocked.push(url.href)
		return route.abort("blockedbyclient")
	})
	return { blocked, quoted }
}
