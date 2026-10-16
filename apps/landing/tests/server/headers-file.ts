/**
 * The subset of Cloudflare's `_headers` syntax the build emits: exact paths and the `/*` splat, each
 * followed by indented `Name: value` lines. Anything else throws, so the local server never guesses at
 * a rule the Worker would read differently.
 */
export interface HeaderRule {
	readonly path: string
	readonly headers: ReadonlyArray<readonly [string, string]>
}

function parsePath(line: string, at: number): string {
	const path = line.trim()
	const exact = /^\/[^\s*:!]*$/.test(path)
	if (path !== "/*" && !exact) throw new Error(`_headers line ${at}: unsupported path pattern '${path}'`)
	return path
}

function parseHeader(line: string, at: number): readonly [string, string] {
	const match = /^\s+([A-Za-z0-9-]+):\s*(.+)$/.exec(line)
	if (!match || line.trimStart().startsWith("!")) throw new Error(`_headers line ${at}: unsupported header line '${line}'`)
	return [match[1], match[2].trim()]
}

export function parseHeadersFile(source: string): HeaderRule[] {
	const rules: { path: string; headers: (readonly [string, string])[] }[] = []
	source.split("\n").forEach((line, index) => {
		const at = index + 1
		if (line.trim() === "") return
		if (!/^\s/.test(line)) {
			rules.push({ path: parsePath(line, at), headers: [] })
			return
		}
		const rule = rules.at(-1)
		if (!rule) throw new Error(`_headers line ${at}: header before any path`)
		rule.headers.push(parseHeader(line, at))
	})
	return rules
}

/** Headers for a path: every matching rule applies, and a name set twice is joined with a comma, as on the Worker. */
export function headersFor(rules: readonly HeaderRule[], path: string): Map<string, string> {
	const out = new Map<string, string>()
	for (const rule of rules) {
		if (rule.path !== "/*" && rule.path !== path) continue
		for (const [name, value] of rule.headers) {
			const key = name.toLowerCase()
			const prior = out.get(key)
			out.set(key, prior === undefined ? value : `${prior}, ${value}`)
		}
	}
	return out
}
