/** The three wallet shapes the suite connects tools to. Only the local target lists them. */
export type TestWalletProfile = "plain" | "selfpay" | "full"

export const PROFILES: readonly TestWalletProfile[] = ["plain", "selfpay", "full"]

/** The app id tools connects under (`useWalletConnection.ts`); every other dApp is refused. */
export const TOOLS_APP_ID = "unleashed"

export const DAPP_SELF_PAY_FEATURE = "dapp-self-pay"

export function parseProfile(raw: string | null): TestWalletProfile {
	if (raw === null) return "plain"
	if ((PROFILES as readonly string[]).includes(raw)) return raw as TestWalletProfile
	throw new Error(`test wallet: unknown profile "${raw}" (expected ${PROFILES.join(" | ")})`)
}

/** What the wallet's build bakes in: the sandbox's node + chain identity and the one origin it serves. */
export interface TestWalletIdentity {
	nodeUrl: string
	l1ChainId: number
	rollupVersion: number
	toolsOrigin: string
}

/** An actor the suite created in Node: the same Nulo derivation runs here, so the address matches. */
export interface Seed {
	secret: `0x${string}`
	salt: string
}
