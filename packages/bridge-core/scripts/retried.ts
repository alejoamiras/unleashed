/**
 * `read`, retried on any error up to `attempts` times, `delayMs` apart: a load-balanced RPC can route a read to a
 * backend that has not reached a block the caller has already seen.
 */
export async function retried<T>(read: () => Promise<T>, attempts = 10, delayMs = 1_000): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await read()
		} catch (e) {
			if (attempt >= attempts) throw e
			await new Promise((r) => setTimeout(r, delayMs))
		}
	}
}
