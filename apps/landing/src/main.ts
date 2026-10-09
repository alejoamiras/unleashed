import "@unleashed/design/base.css"
import "./styles/landing.css"
import { COPY } from "./content.ts"
import { DitherField } from "./engines/dither.ts"
import { type Engine, readPalette } from "./engines/engine.ts"
import { Loop } from "./engines/loop.ts"
import { createCard, isEngineId } from "./engines/registry.ts"
import { FACES, fontsLoaded } from "./fonts.ts"
import { type MotionState, motionLabel, playing, shouldRun } from "./motion.ts"

const root = document.documentElement
const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
const lightQuery = window.matchMedia("(prefers-color-scheme: light)")
const motion: MotionState = { reduce: reduceQuery.matches, userChoice: null, hidden: document.hidden }
const palette = readPalette(getComputedStyle(root))
const engines = new Set<Engine>()
const cards = new Map<Element, Engine>()
const sized = new Map<Element, Engine>()
const button = document.querySelector<HTMLButtonElement>("[data-motion]")

const loop = new Loop((engine) => shouldRun(motion, engine.visible), retire)
const resizer = new ResizeObserver((entries) => {
	for (const { target } of entries) {
		const engine = sized.get(target)
		if (engine) loop.guard(engine, () => engine.resize())
	}
})
const watcher = new IntersectionObserver((entries) => {
	for (const entry of entries) {
		const engine = cards.get(entry.target)
		if (engine) engine.visible = entry.isIntersecting
	}
	sync()
})

/** An engine that threw: nothing calls it again, and its screen goes, as without scripts. */
function retire(engine: Engine, error: unknown): void {
	engines.delete(engine)
	cards.delete(engine.canvas)
	sized.delete(engine.sizedBy)
	resizer.unobserve(engine.sizedBy)
	watcher.unobserve(engine.canvas)
	hide(engine.canvas)
	console.error("landing: a motion engine stopped", error)
}

/** Pushes the motion state to every surface that shows it, then lets the loop run if it may. */
function sync(): void {
	if (button) button.textContent = playing(motion) ? COPY.pause : COPY.play
	for (const engine of engines) engine.canvas.dataset.state = motionLabel(motion, engine.visible)
	loop.wake()
}

/** Starts one engine and registers it once its first draw succeeds; a failure leaves the rest running. */
function start(make: () => Engine): Engine | null {
	let engine: Engine
	try {
		engine = make()
	} catch {
		return null
	}
	loop.guard(engine, () => {
		engine.resize(true)
		engines.add(engine)
		sized.set(engine.sizedBy, engine)
		resizer.observe(engine.sizedBy)
		loop.add(engine)
	})
	return engines.has(engine) ? engine : null
}

/** A card's whole screen, or the field's own canvas. */
function hide(canvas: HTMLCanvasElement): void {
	const target = canvas.closest<HTMLElement>(".screen") ?? canvas
	target.hidden = true
}

/** Card screens draw text, so they start once their faces load or the wait runs out. */
async function startCards(): Promise<void> {
	await fontsLoaded([FACES.mono, FACES.body], "SIGNAL NOISE 250.00 USDC Ethereum Aztec")
	for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas[data-engine]")) {
		const id = canvas.dataset.engine
		const engine = isEngineId(id) ? start(() => createCard(id, canvas, palette)) : null
		if (!engine) {
			hide(canvas)
			continue
		}
		cards.set(canvas, engine)
		watcher.observe(canvas)
	}
	sync()
}

function retheme(): void {
	root.setAttribute("theme", lightQuery.matches ? "light" : "dark")
	readPalette(getComputedStyle(root), palette)
	for (const engine of engines) loop.guard(engine, () => engine.draw())
}

function wireControls(): void {
	if (button) {
		button.hidden = false
		button.addEventListener("click", () => {
			motion.userChoice = playing(motion) ? "pause" : "play"
			sync()
		})
	}
	reduceQuery.addEventListener("change", () => {
		motion.reduce = reduceQuery.matches
		sync()
	})
	lightQuery.addEventListener("change", retheme)
	document.addEventListener("visibilitychange", () => {
		motion.hidden = document.hidden
		sync()
	})
}

// The wordmark's converge animation only reads on its own face (landing.css gates it on this class).
fontsLoaded([FACES.pixel], COPY.brand).then(() => root.classList.add("fonts-ready"))

const land = document.getElementById("land")
if (land) start(() => new DitherField(land, palette, () => playing(motion)))
wireControls()
sync()
startCards()
