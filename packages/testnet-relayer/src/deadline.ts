/** A deadline for a run's reads: past it the work is abandoned, never awaited, and reaches no further read. */

/** The work passed its deadline. */
export class PastDeadline extends Error {}

/** One read of deadlined work; refused once the deadline has passed, so abandoned work stops at its next read. */
export type Read = <T>(read: () => Promise<T>) => Promise<T>

/** `work` raced against `ms`; past it `work` is abandoned with {@link PastDeadline} and every read it tries is refused. */
export async function withinDeadline<T>(ms: number, work: (read: Read) => Promise<T>): Promise<T> {
	let expired = false
	const read: Read = (fn) => (expired ? Promise.reject(new PastDeadline("abandoned past its deadline")) : fn())
	if (ms === Number.POSITIVE_INFINITY) return work(read)
	let timer: ReturnType<typeof setTimeout> | undefined
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			expired = true
			reject(new PastDeadline(`the reads passed their ${Math.round(ms / 1000)} s`))
		}, ms)
	})
	try {
		return await Promise.race([work(read), deadline])
	} finally {
		clearTimeout(timer)
	}
}
