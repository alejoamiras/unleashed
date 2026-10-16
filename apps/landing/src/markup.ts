/**
 * The page body as static HTML, rendered at build time (vite.config.ts) so the first frame is
 * complete without JavaScript. Pure string functions: every text node and attribute value passes
 * through esc().
 */
import { ICONS, type PixelIconName } from "@unleashed/design/core/icons.ts"
import { MARK_INK, MARK_SIGNAL } from "@unleashed/design/core/mark.ts"
import { COPY, EXPERIMENTS, type Experiment, LINKS, SCREEN_PLACEMENT, TAG_LABELS, type TagKind } from "./content.ts"

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

export function esc(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch])
}

export function icon(name: PixelIconName, size: 12 | 24): string {
	const { viewBox, d } = ICONS[name]
	const paths = d.map((path) => `<path d="${esc(path)}"/>`).join("")
	return `<svg class="ic" viewBox="${esc(viewBox)}" width="${size}" height="${size}" aria-hidden="true">${paths}</svg>`
}

export function mark(): string {
	return `<svg class="mark" viewBox="0 0 8 8" shape-rendering="crispEdges" aria-hidden="true"><path d="${MARK_INK}" fill="currentColor"/><path class="sig" d="${MARK_SIGNAL}"/></svg>`
}

const lockup = (cls = "lockup") => `<span class="${cls}">${mark()}<span class="wordmark">${esc(COPY.brand)}</span></span>`

const link = (cls: string, href: string, body: string) => `<a${cls ? ` class="${cls}"` : ""} href="${esc(href)}">${body}</a>`

function nav(): string {
	const links = COPY.navLinks.map((l) => link("txt ul-notch", l.href, esc(l.label))).join("")
	const cta = link("btn secondary sm ul-notch", LINKS.app, esc(COPY.navCta))
	return `<nav class="l-nav ul-notch" aria-label="${esc(COPY.brand)}">${lockup("lockup ul-notch")}<div class="l-links">${links}${cta}</div></nav>`
}

function hero(): string {
	const primary = link("btn primary ul-notch", LINKS.app, `${esc(COPY.primaryCta)} ${icon("arrow-right", 12)}`)
	const source = link("btn secondary ul-notch", LINKS.source, `${esc(COPY.sourceCta)} ${icon("external-link", 12)}`)
	return [
		`<section class="c-hero">`,
		`<p class="wm-hero ul-notch" aria-hidden="true">${esc(COPY.brand)}</p>`,
		`<div class="c-copy ul-notch">`,
		`<h1 class="h-hero">${esc(COPY.heading)}</h1>`,
		`<p class="lede">${esc(COPY.lede)}</p>`,
		`<div class="cta">${primary}${source}</div>`,
		`</div></section>`,
	].join("")
}

const TAG_STYLE: Readonly<Record<TagKind, { cls: string; icon: PixelIconName }>> = {
	live: { cls: "carrier", icon: "check" },
	private: { cls: "private", icon: "eye-off" },
	lab: { cls: "other", icon: "zap" },
}

export function tag(kind: TagKind): string {
	const style = TAG_STYLE[kind]
	return `<span class="tag ${style.cls} ul-notch">${icon(style.icon, 12)}${esc(TAG_LABELS[kind])}</span>`
}

/** A row's screen is decoration inside its link; noscript.css hides it when no script can draw it. */
function screen(experiment: Experiment): string {
	return experiment.engine
		? `<span class="screen ul-notch" aria-hidden="true"><canvas data-engine="${experiment.engine}"></canvas></span>`
		: ""
}

export function experimentRow(experiment: Experiment): string {
	const tags = experiment.tags.map(tag).join("")
	const body = `<strong>${esc(experiment.name)}</strong><span class="tags">${tags}</span><span class="sub">${esc(experiment.description)}</span>${screen(experiment)}`
	return experiment.href ? `<li>${link("ul-notch", experiment.href, body)}</li>` : `<li><div class="empty ul-notch">${body}</div></li>`
}

function experiments(): string {
	return [
		`<section class="narrow" aria-labelledby="experiments">`,
		`<header class="sec-h ul-notch"><h2 id="experiments">${esc(COPY.experimentsTitle)}</h2><p>${esc(COPY.experimentsSub)}</p></header>`,
		`<ul class="idx" data-placement="${SCREEN_PLACEMENT}">${EXPERIMENTS.map(experimentRow).join("")}</ul>`,
		`</section>`,
	].join("")
}

function caveat(): string {
	return [
		`<div class="narrow"><aside class="note ul-notch" aria-label="${esc(COPY.caveatLabel)}">`,
		icon("warning-diamond", 24),
		`<div><strong>${esc(COPY.caveatTitle)}</strong><p>${esc(COPY.caveatBody)}</p></div>`,
		`</aside></div>`,
	].join("")
}

/** The Pause button ships hidden: main.ts reveals it once it can honour it. */
function footer(): string {
	const facts = COPY.footer.facts.map((fact) => `<span>${esc(fact)}</span>`).join("")
	const pause = `<button type="button" class="btn quiet sm ul-notch" data-motion hidden>${esc(COPY.pause)}</button>`
	return `<footer class="l-foot ul-notch">${lockup()}${link("", LINKS.source, esc(COPY.footer.source))}${facts}${pause}</footer>`
}

export function renderBody(): string {
	return `<div class="land" id="land"><div class="land-in">${nav()}<main class="land-main">${hero()}${experiments()}${caveat()}</main>${footer()}</div></div>`
}
