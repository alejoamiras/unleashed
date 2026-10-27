/**
 * The core every quote hook shares. Questions hang off input fields, so they are debounced; a stale answer
 * landing after a fresher one would price the wrong thing, so only the latest question publishes; and an
 * answer is readable only beside the question it answers, and only until it is older than the TTL.
 */
import { type Ref, ref, shallowRef } from "vue"

/** An answer, the question it answers, and when it landed (`now()` at landing). */
export interface Answered<Q, A> {
	readonly question: Q
	readonly answer: A
	readonly at: number
}

/** What a run settles to: its answer, and the message to show beside it (null when there is nothing to say). */
export interface Settled<A> {
	answer: A
	error: string | null
}

export interface LatestQuote<Q, A> {
	readonly answered: Ref<Answered<Q, A> | null>
	readonly loading: Ref<boolean>
	readonly error: Ref<string | null>
	/** Replaces any pending question and drops the current answer at once; resolves when this question settles or is
	 *  superseded, never rejects. */
	ask(question: Q): Promise<void>
	/** The answer while it is younger than the TTL; without a TTL, the answer. */
	fresh(): Answered<Q, A> | null
	dispose(): void
}

export interface LatestQuoteOptions {
	debounceMs: number
	ttlMs?: number
	now?: () => number
}

/** `run` may throw: the throw settles the question with no answer and its message as the error. */
export function latestQuote<Q, A>(run: (question: Q) => Promise<Settled<A>>, o: LatestQuoteOptions): LatestQuote<Q, A> {
	const now = o.now ?? Date.now
	const answered = shallowRef<Answered<Q, A> | null>(null)
	const loading = ref(false)
	const error = ref<string | null>(null)
	let timer: ReturnType<typeof setTimeout> | null = null
	let pending: { seq: number; resolve: () => void } | null = null
	let seq = 0
	let disposed = false

	const stale = (mine: number): boolean => disposed || mine !== seq

	/** A run resolves its OWN caller; a superseded run must not resolve the one that replaced it. */
	function settle(mine: number): void {
		if (pending?.seq !== mine) return
		pending.resolve()
		pending = null
	}

	function settleAll(): void {
		pending?.resolve()
		pending = null
	}

	async function execute(question: Q, mine: number): Promise<void> {
		let settled: Settled<A> | { error: string }
		try {
			settled = await run(question)
		} catch (e) {
			settled = { error: e instanceof Error ? e.message : String(e) }
		}
		if (stale(mine)) return
		answered.value = "answer" in settled ? { question, answer: settled.answer, at: now() } : null
		error.value = settled.error
		loading.value = false
	}

	function ask(question: Q): Promise<void> {
		if (disposed) return Promise.resolve()
		if (timer !== null) clearTimeout(timer)
		settleAll()
		// Synchronous: an answer cleared only when the next one lands would leave the whole debounce window
		// answering the previous question.
		answered.value = null
		error.value = null
		loading.value = true
		const mine = ++seq
		return new Promise<void>((resolve) => {
			pending = { seq: mine, resolve }
			timer = setTimeout(() => {
				timer = null
				void execute(question, mine).finally(() => settle(mine))
			}, o.debounceMs)
		})
	}

	function fresh(): Answered<Q, A> | null {
		const a = answered.value
		if (!a || o.ttlMs === undefined) return a
		return now() - a.at <= o.ttlMs ? a : null
	}

	function dispose(): void {
		disposed = true
		seq++
		if (timer !== null) clearTimeout(timer)
		timer = null
		loading.value = false
		settleAll()
	}

	return { answered, loading, error, ask, fresh, dispose }
}
