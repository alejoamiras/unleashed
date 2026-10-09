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
const button = document.querySelector<HTMLButtonElement>("[data-motion]")

const loop = new Loop(
	(engine) => shouldRun(motion, engine.visible),
	(engine, error) => {
		engines.delete(engine)
		hideScreen(engine.canvas)
		console.error("landing: a motion engine stopped", error)
	},
)

/** Pushes the motion state to every surface that shows it, then lets the loop run if it may. */
function sync(): void {
	if (button) button.textContent = playing(motion) ? COPY.pause : COPY.play
	for (const engine of engines) engine.canvas.dataset.state = motionLabel(motion, engine.visible)
	loop.wake()
}

/** Starts one engine; one that cannot start leaves the page as it was and the rest running. */
function start(make: () => Engine, onFail: () => void): Engine | null {
	try {
		const engine = make()
		engines.add(engine)
		engine.resize(true)
		loop.add(engine)
		return engine
	} catch {
		onFail()
		return null
	}
}

/** A row whose screen cannot be drawn shows no screen, as without scripts. */
function hideScreen(canvas: Element): void {
	const screen = canvas.closest<HTMLElement>(".screen")
	if (screen) screen.hidden = true
}

/** Card screens draw text, so they start once their faces load or the wait runs out. */
async function startCards(): Promise<void> {
	await fontsLoaded([FACES.mono, FACES.body], "SIGNAL NOISE 250.00 USDC Ethereum Aztec")
	const watcher = new IntersectionObserver((entries) => {
		for (const entry of entries) {
			const engine = cards.get(entry.target)
			if (engine) engine.visible = entry.isIntersecting
		}
		sync()
	})
	for (const canvas of document.querySelectorAll<HTMLCanvasElement>("canvas[data-engine]")) {
		const id = canvas.dataset.engine
		const engine = isEngineId(id)
			? start(
					() => createCard(id, canvas, palette),
					() => hideScreen(canvas),
				)
			: null
		if (!engine) {
			hideScreen(canvas)
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
	for (const engine of engines) engine.draw()
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
if (land)
	start(
		() => new DitherField(land, palette, () => playing(motion)),
		() => undefined,
	)
wireControls()
sync()
startCards()
