/**
 * A legal document as a static page, rendered at build time (vite.config.ts) like the landing's body,
 * with no script but the theme boot. Every text node and attribute value passes through esc().
 */
import type { Block, ProviderRow } from "@unleashed/legal"
import { COPY } from "./content.ts"
import { LEGAL_PAGES, type LegalPage } from "./legal-pages.ts"
import { esc, footer, link, mark } from "./markup.ts"

const provider = (row: ProviderRow) =>
	`<div><dt>${esc(row.name)}</dt><dd>${esc(row.role)}</dd><dd>${esc(row.sees)}</dd><dd>${link("", row.policyUrl, esc(`${row.name}'s privacy policy`))}</dd></div>`

export function block(b: Block): string {
	switch (b.kind) {
		case "p":
			return `<p>${esc(b.text)}</p>`
		case "list":
			return `<ul>${b.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
		case "providers":
			return `<dl class="providers">${b.rows.map(provider).join("")}</dl>`
	}
}

function nav(page: LegalPage): string {
	const home = link("lockup ul-notch", "/", `${mark()}<span class="wordmark">${esc(COPY.brand)}</span>`)
	const docs = LEGAL_PAGES.map(
		(p) => `<a class="doc ul-notch" href="${esc(p.path)}"${p.file === page.file ? ' aria-current="page"' : ""}>${esc(p.doc.title)}</a>`,
	).join("")
	return `<nav class="l-nav ul-notch" aria-label="${esc(COPY.brand)}">${home}<div class="l-links">${docs}</div></nav>`
}

export function legalHead(page: LegalPage): string {
	const title = esc(`${page.doc.title} · ${COPY.brand}`)
	const description = esc(`The ${page.doc.title} of ${COPY.brand}, a lab for private apps on Aztec.`)
	const url = esc(page.url)
	return [
		`<title>${title}</title>`,
		`<meta name="description" content="${description}" />`,
		`<link rel="canonical" href="${url}" />`,
		`<meta property="og:type" content="website" />`,
		`<meta property="og:url" content="${url}" />`,
		`<meta property="og:title" content="${title}" />`,
		`<meta property="og:description" content="${description}" />`,
		`<meta name="twitter:card" content="summary" />`,
	].join("\n\t")
}

export function legalBody(page: LegalPage): string {
	const { doc } = page
	const sections = doc.sections
		.map((section, i) => `<section><h2>${i + 1}. ${esc(section.heading)}</h2>${section.blocks.map(block).join("")}</section>`)
		.join("")
	const main = `<main class="legal" data-legal-doc="${esc(doc.id)}"><h1>${esc(doc.title)}</h1><p class="updated">Last updated ${esc(doc.updated)}</p>${sections}</main>`
	return `<div class="land legal-page"><div class="land-in">${nav(page)}${main}${footer(false)}</div></div>`
}
