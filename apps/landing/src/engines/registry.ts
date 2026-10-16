import type { EngineId } from "../content.ts"
import { BothWays } from "./both.ts"
import { type CardModel, CardScreen } from "./card.ts"
import { Drip } from "./drip.ts"
import { StaticNoise } from "./draw.ts"
import type { Palette } from "./engine.ts"
import { Tuner } from "./tuner.ts"

const MODELS: Readonly<Record<EngineId, (rand: () => number) => CardModel>> = {
	both: (rand) => new BothWays(rand, new StaticNoise(rand)),
	drip: () => new Drip(),
	tuner: (rand) => new Tuner(rand),
}

export function isEngineId(value: string | undefined): value is EngineId {
	return value !== undefined && Object.hasOwn(MODELS, value)
}

export function createCard(id: EngineId, canvas: HTMLCanvasElement, palette: Palette, rand: () => number = Math.random): CardScreen {
	return new CardScreen(canvas, palette, MODELS[id](rand))
}
