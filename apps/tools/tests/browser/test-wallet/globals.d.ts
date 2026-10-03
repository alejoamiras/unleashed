import type { Seed, TestWalletIdentity, TestWalletProfile } from "./profile"

/** The suite's control surface, reached through the wallet frame. */
export interface TestWalletControl {
	profile: TestWalletProfile
	ready: () => Promise<void>
	addAccount: (secret: `0x${string}`, salt?: string) => Promise<string>
	accounts: () => Promise<string[]>
	/** How many times each wallet method was called since this frame loaded (`sendTx`, `createAuthWit`, …). */
	calls: () => Record<string, number>
	/** Every transaction handed to the node since the wallet booted: its hash, the fee limit the FPC
	 *  keeps for it (a decimal string) and the gas limits it was submitted under. */
	submitted: () => Promise<{ hash: string; feeLimit: string; daGas: number; l2Gas: number }[]>
	/** Fault injection: the next `method` call whose serialized arguments contain `pattern` (any
	 *  call when omitted) rejects with `message` instead of running — one shot. */
	failNext: (method: string, pattern?: string, message?: string) => void
	/** The next matching call parks unanswered — a wallet gone mid-call — until `release` (or a reload). One shot. */
	holdNext: (method: string, pattern?: string) => void
	/** Runs every held call as if it had never been held; how many there were. */
	release: () => number
	/** The next matching call RUNS but never answers — the transaction is sent, the reply is lost. One shot. */
	swallowNext: (method: string, pattern?: string) => void
	/** The next transaction handed to the node is recorded and thrown away: the page gets its hash,
	 *  the node never sees it. One shot. */
	dropNextSubmission: () => Promise<void>
	/** The next capability prompt grants no contract scope — a declined token grant. One shot. */
	declineNextGrant: () => Promise<void>
}

declare global {
	/** Baked by `vite.config.mts` from the sandbox run's artifacts. */
	const __TEST_WALLET__: TestWalletIdentity
	interface Window {
		__unleashedTestWallet?: TestWalletControl
		/** Set by the suite's context init script before any page script runs. */
		__unleashedTestWalletSeeds?: Seed[]
	}
}
