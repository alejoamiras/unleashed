/** A bare dRPC key: anything else could rewrite the URL's path, query or host. */
const URL_SAFE_KEY = /^[A-Za-z0-9_-]+$/

/**
 * The dRPC node URL for `network`, from `env.DRPC_API_KEY`. Throws, naming the variable but never
 * its value, when the key is unset or not URL-safe (`[A-Za-z0-9_-]+`); there is no fallback node.
 * The URL carries the key: never log it, persist it or put it in an error.
 * Callers pass `process.env` at operation entry, not at import, so importing a script needs no key
 * and this module, which the package index re-exports to the browser, never touches `process`.
 */
export function requireDrpcNodeUrl(network: "testnet" | "mainnet", env: Record<string, string | undefined>): string {
	const key = env.DRPC_API_KEY
	if (!key) throw new Error("DRPC_API_KEY is unset: run this through its keyed-run template (*.env.example)")
	if (!URL_SAFE_KEY.test(key)) throw new Error("DRPC_API_KEY is not a bare URL-safe key ([A-Za-z0-9_-]+)")
	return `https://lb.drpc.live/aztec-${network}/${key}`
}

const ERROR_CODE = /^[A-Za-z_]+$/

/**
 * POSTs one JSON-RPC call to `url`. A rejected fetch is rethrown naming only `method` and the
 * runtime's error code: the runtime's own error carries the URL (Bun sets `path` to it), and a dRPC
 * URL carries its key.
 */
export async function postNodeRpc(url: string, method: string, params: unknown[]): Promise<Response> {
	try {
		return await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		})
	} catch (err) {
		const code = (err as { code?: unknown } | null)?.code
		throw new Error(`${method}: node request failed${typeof code === "string" && ERROR_CODE.test(code) ? ` (${code})` : ""}`)
	}
}

/**
 * The JSON-RPC envelope of a `postNodeRpc` response from `url`. Throws `${method}: HTTP <status>` on
 * a non-OK status, and a fixed `${method}: unreadable RPC response` when the body is unreadable or is
 * not a JSON object: the runtime's read error is dropped because Bun's carries the URL. A JSON-RPC
 * `error` throws with its message, every occurrence of `url` and of its last path segment (a dRPC
 * key) replaced, since a server may echo either. Returns the envelope without checking `result`.
 */
export async function readNodeRpcBody<T>(res: Response, method: string, url: string): Promise<{ jsonrpc?: unknown; result?: T }> {
	if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`)
	let body: unknown
	try {
		body = await res.json()
	} catch {
		throw new Error(`${method}: unreadable RPC response`)
	}
	if (typeof body !== "object" || body === null) throw new Error(`${method}: unreadable RPC response`)
	const { error } = body as { error?: { message?: unknown } }
	if (error) {
		const key = url.slice(url.lastIndexOf("/") + 1)
		let message = String(error.message).replaceAll(url, "<node-url>")
		if (key) message = message.replaceAll(key, "<key>")
		throw new Error(`${method}: RPC error — ${message}`)
	}
	return body as { jsonrpc?: unknown; result?: T }
}
