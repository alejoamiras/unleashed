/**
 * F1, "Drip", for the Faucet row: a tap drips SIGNAL and NOISE in turn; each drop lands as a coin and
 * rolls into the wallet, which lights as a coin arrives.
 */
import { ICONS } from "@unleashed/design/core/icons.ts"
import { bandTop, type CardModel } from "./card.ts"
import { drawIcon, MONO_FONT, notchPath } from "./draw.ts"
import type { Palette } from "./engine.ts"

const STEP_PX = 4
const DRIP_EVERY = 6
const FLASH_STEPS = 3
const PREWARM_STEPS = 120
const TAP_X = 20
// Token names beside the wallet need this much room.
const NAMES_FROM = 300

/** 0 is SIGNAL, 1 is NOISE: they alternate. */
type Token = 0 | 1

export class Drip implements CardModel {
	readonly tick = 90
	drops: { y: number; token: Token }[] = []
	coins: { x: number; token: Token }[] = []
	/** Steps left of the wallet's light. */
	flash = 0
	private count = 0
	private dripped = 0
	private oy = 0
	private rail = 0
	private wallet = 0
	private width = 0

	layout(width: number, height: number): void {
		this.width = width
		this.oy = bandTop(height)
		this.rail = this.oy + 38
		this.wallet = width - 26
		this.drops = []
		this.coins = []
		this.flash = 0
		this.count = 0
		for (let i = 0; i < PREWARM_STEPS; i++) this.step()
	}

	step(): void {
		this.count++
		if (this.flash) this.flash--
		if (this.count % DRIP_EVERY === 0) this.drops.push({ y: this.oy + 12, token: (this.dripped++ % 2) as Token })
		for (const drop of this.drops) drop.y += STEP_PX
		const landed = this.drops.filter((drop) => drop.y >= this.rail - 6)
		this.drops = this.drops.filter((drop) => drop.y < this.rail - 6)
		for (const drop of landed) this.coins.push({ x: TAP_X - 2, token: drop.token })
		for (const coin of this.coins) coin.x += STEP_PX
		const rolling = this.coins.filter((coin) => coin.x < this.wallet - 6)
		if (rolling.length < this.coins.length) this.flash = FLASH_STEPS
		this.coins = rolling
	}

	draw(ctx: CanvasRenderingContext2D, palette: Palette): void {
		const color = (token: Token) => (token ? palette.ink2 : palette.signal)
		ctx.fillStyle = palette.ink3
		ctx.fillRect(4, this.oy + 4, 24, 4)
		ctx.fillRect(18, this.oy + 8, 6, 4)
		ctx.fillStyle = palette.line
		for (let x = 8; x < this.wallet - 4; x += 8) ctx.fillRect(x, this.rail + 4, 2, 2)
		for (const drop of this.drops) {
			ctx.fillStyle = color(drop.token)
			ctx.fillRect(TAP_X, drop.y, 4, 4)
		}
		for (const coin of this.coins) {
			notchPath(ctx, coin.x, this.rail - 6, 8, 8, 2)
			ctx.fillStyle = color(coin.token)
			ctx.fill()
		}
		drawIcon(ctx, ICONS.wallet.d, this.wallet, this.oy + 18, 20, this.flash ? palette.carrier : palette.ink2)
		if (this.width >= NAMES_FROM) this.drawNames(ctx, palette)
	}

	private drawNames(ctx: CanvasRenderingContext2D, palette: Palette): void {
		ctx.font = `500 10px ${MONO_FONT}`
		ctx.textBaseline = "middle"
		ctx.textAlign = "end"
		ctx.fillStyle = palette.signal
		ctx.fillText("SIGNAL", this.wallet - 10, this.oy + 8)
		ctx.fillStyle = palette.ink2
		ctx.fillText("NOISE", this.wallet - 10, this.oy + 20)
		ctx.textAlign = "start"
	}
}
