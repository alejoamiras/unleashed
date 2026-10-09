/**
 * Everything the page says and links to. Imports nothing, so the build guard can read the link
 * allowlist without pulling in page code. A new experiment is a new entry in EXPERIMENTS.
 */

/** Every destination the page links to. A link outside this object fails the unit tests and the build guard. */
export const LINKS = {
	app: "https://testnet.app.unleashed.systems",
	source: "https://github.com/alejoamiras/unleashed",
} as const

/** Both hosts serve this page; search engines are pointed at the apex. */
export const CANONICAL = "https://unleashed.systems/"

export type Href = (typeof LINKS)[keyof typeof LINKS]

export type TagKind = "live" | "private" | "lab"

/** The card engines the page ships. Each maps to one class in src/engines/registry.ts. */
export type EngineId = "both" | "drip" | "tuner"

export interface Experiment {
	readonly name: string
	/** null renders the open slot: a row that is not a link. */
	readonly href: Href | null
	readonly tags: readonly TagKind[]
	readonly description: string
	readonly engine: EngineId | null
}

export const COPY = {
	brand: "Unleashed",
	heading: "Privacy nobody can switch off, tested in the open.",
	lede: "Unleashed is a lab for private apps on Aztec. Every experiment is a working app with its source in the open, built to find out what unstoppable privacy can do today.",
	primaryCta: "Open the bridge",
	sourceCta: "View source",
	navLinks: [
		{ label: "Faucet", href: LINKS.app },
		{ label: "Source", href: LINKS.source },
	],
	navCta: "Open the app",
	experimentsTitle: "Experiments",
	experimentsSub: "Two on testnet. The next one is in the lab.",
	caveatLabel: "Before you try anything",
	caveatTitle: "Experiments, not products.",
	caveatBody:
		"Each one is built with care and kept running on a best-effort basis. None of them is production ready, so use testnet funds or amounts you can afford to lose.",
	footer: {
		source: "Source on GitHub",
		facts: ["Apache-2.0", "Works with any Aztec wallet", "Mainnet is not open yet"],
	},
	pause: "Pause motion",
	play: "Play motion",
} as const

export const TAG_LABELS: Readonly<Record<TagKind, string>> = {
	live: "Live on testnet",
	private: "Private sends",
	lab: "In the lab",
}

export const EXPERIMENTS: readonly Experiment[] = [
	{
		name: "Bridge",
		href: LINKS.app,
		tags: ["live", "private"],
		description:
			"Move any ERC-20 between Ethereum and Aztec, in public or in private. Part of it can arrive as gas, so a new account can pay its own way.",
		engine: "both",
	},
	{
		name: "Faucet",
		href: LINKS.app,
		tags: ["live"],
		description: "Mint SIGNAL and NOISE, the two test tokens, to your Aztec account. No sign-up and no rate limit.",
		engine: "drip",
	},
	{
		name: "Next",
		href: null,
		tags: ["lab"],
		description: "Nothing on this channel yet. The next experiment is in the lab. Its source lands here with it.",
		engine: "tuner",
	},
]

/**
 * Where a card's screen sits. Strip is built while the owner's pick is pending; Tile is a CSS rule
 * away, because every engine lays out from its canvas size.
 */
export const SCREEN_PLACEMENT: "strip" | "tile" = "strip"
