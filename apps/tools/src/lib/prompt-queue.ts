/**
 * One wallet prompt at a time, app-wide. Two capability requests racing would each REPLACE the
 * stored grant, so the later approval could drop what the earlier one added; a membership read
 * racing a grant could overwrite the wider answer with the narrower one.
 */
let promptQueue: Promise<void> = Promise.resolve()

export function enqueuePrompt<T>(run: () => Promise<T>): Promise<T> {
	const next = promptQueue.then(run)
	// The chain must outlive a rejected prompt: a queue left in a rejected state would fail every
	// later request without ever reaching the wallet.
	promptQueue = next.then(
		() => undefined,
		() => undefined,
	)
	return next
}

/** How long a submit waits on the prompts queued ahead of it before it gives up. */
export const PROMPT_WAIT_MS = 60_000

/** A submit's refusal when the prompts queued ahead of it did not settle within `PROMPT_WAIT_MS`. */
export const PROMPTS_STALLED = "Your wallet hasn't finished an earlier request. Check your wallet and try again. Nothing was sent."

/**
 * True once every prompt queued before the call has settled, either way; false after `withinMs`.
 * Never rejects. Do not await it inside a queued prompt: it waits on itself until timeout. It is not a
 * lock: a later prompt may start as soon as it resolves, so the caller's own checks must follow it.
 */
export function promptsSettled(withinMs: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), withinMs)
	})
	return Promise.race([promptQueue.then(() => true), expired]).finally(() => clearTimeout(timer))
}

/** Statuses in which the session is mid-flow: `retryCapabilities` no-ops in exactly these, so the
 *  wallet is never asked and never refuses anything. Any OTHER non-connected status is a real one. */
export const MID_FLOW_STATUSES: ReadonlySet<string> = new Set([
	"discovering",
	"choosing",
	"verifying",
	"capability-approval",
	"choosing-account",
	"setting-up",
])

/** Test-only: drop the queue between cases. */
export function __resetPromptQueueForTests(): void {
	promptQueue = Promise.resolve()
}
