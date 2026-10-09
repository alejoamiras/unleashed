/**
 * Serves a built dist/ the way the assets-only Worker does, for the browser smoke: the emitted
 * `_headers` rules for the request path, index.html for an unmatched navigation, and a 404 for any
 * other unmatched request. Binds port 0 on loopback and is closed by the process that opened it, so
 * parallel runs never share a port or leave a server behind.
 */
import { readFile, stat } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { extname, join, resolve, sep } from "node:path"
import { headersFor, parseHeadersFile } from "./headers-file.ts"

const TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
}

// Config files the Worker reads but never serves.
const NOT_SERVED = new Set(["/_headers", "/_redirects"])

export interface StaticServer {
	readonly origin: string
	close(): Promise<void>
}

async function fileFor(root: string, path: string): Promise<string | null> {
	if (NOT_SERVED.has(path)) return null
	const file = resolve(root, `.${path === "/" ? "/index.html" : path}`)
	if (file !== root && !file.startsWith(root + sep)) return null
	const info = await stat(file).catch(() => null)
	return info?.isFile() ? file : null
}

export async function serveDist(dist: string): Promise<StaticServer> {
	const root = resolve(dist)
	const rules = parseHeadersFile(await readFile(join(root, "_headers"), "utf8"))
	const server = createServer(async (req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? "/", "http://local").pathname)
		const navigation = req.headers["sec-fetch-mode"] === "navigate"
		const file = (await fileFor(root, path)) ?? (navigation ? join(root, "index.html") : null)
		const headers = Object.fromEntries(headersFor(rules, path))
		if (!file) {
			res.writeHead(404, headers).end()
			return
		}
		res.writeHead(200, { ...headers, "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
		res.end(await readFile(file))
	})
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
	const { port } = server.address() as AddressInfo
	return {
		origin: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
	}
}
