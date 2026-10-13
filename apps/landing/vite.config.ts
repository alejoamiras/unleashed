import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { defineConfig, type HtmlTagDescriptor, type Plugin } from "vite"
import { type Channel, channelOf, pageHeaders, renderHeadersFile } from "./security-headers.ts"
import { renderBody } from "./src/markup.ts"

const BODY_SLOT = "<!--landing:body-->"

// Above-the-fold faces only: the heading's body face and the wordmark's pixel face. The mono face is
// drawn on card canvases, which wait for it themselves.
const PRELOADED_FONTS = [/^assets\/AtkinsonHyperlegibleNext-[\w-]+\.woff2$/, /^assets\/SixtyfourConvergence-subset-[\w-]+\.woff2$/]

/** `<version>+<first 8 hex of the commit>`: Workers Builds' commit, else the checkout's. */
function buildId(): string {
	const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }
	const sha = process.env.WORKERS_CI_COMMIT_SHA || gitHead()
	if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`no build identity: WORKERS_CI_COMMIT_SHA or a git checkout, got '${sha ?? ""}'`)
	return `${pkg.version}+${sha?.slice(0, 8)}`
}

function gitHead(): string | null {
	try {
		return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim()
	} catch {
		return null
	}
}

function preloadTags(fileNames: readonly string[]): HtmlTagDescriptor[] {
	return PRELOADED_FONTS.map((pattern) => {
		const file = fileNames.find((name) => pattern.test(name))
		if (!file) throw new Error(`no emitted font matches ${pattern}`)
		return {
			tag: "link",
			attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${file}`, crossorigin: "" },
			injectTo: "head",
		}
	})
}

/** Renders the body into index.html, and emits `_headers` and `build.json` for the Worker. */
function landingPlugin(channel: Channel): Plugin {
	let id = ""
	return {
		name: "unleashed-landing",
		enforce: "post",
		configResolved(config) {
			if (config.command === "build") id = buildId()
		},
		transformIndexHtml: {
			order: "post",
			handler(html, ctx) {
				if (!html.includes(BODY_SLOT)) throw new Error(`index.html has no ${BODY_SLOT}`)
				const page = html.replace(BODY_SLOT, renderBody())
				if (!ctx.bundle) return page
				const meta: HtmlTagDescriptor[] = [{ tag: "meta", attrs: { name: "unleashed-build", content: id }, injectTo: "head" }]
				if (channel === "preview") meta.push({ tag: "meta", attrs: { name: "robots", content: "noindex" }, injectTo: "head" })
				return { html: page, tags: [...preloadTags(Object.keys(ctx.bundle)), ...meta] }
			},
		},
		generateBundle(_options, bundle) {
			const hashed = Object.keys(bundle).filter((name) => name.startsWith("assets/"))
			this.emitFile({ type: "asset", fileName: "_headers", source: renderHeadersFile(channel, hashed) })
			this.emitFile({ type: "asset", fileName: "build.json", source: `${JSON.stringify({ buildId: id, channel }, null, 2)}\n` })
		},
	}
}

const channel = channelOf(process.env.WORKERS_CI_BRANCH)

export default defineConfig({
	plugins: [landingPlugin(channel)],
	build: {
		// Fonts stay files: an inlined data: font would need `font-src data:`.
		assetsInlineLimit: 0,
		modulePreload: { polyfill: false },
	},
	server: { port: Number(process.env.LANDING_DEV_PORT) || 5177 },
	preview: { headers: pageHeaders(channel) },
})
