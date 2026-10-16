import { serveDist } from "../server/static-server.ts"

/**
 * Serves dist/ for the run unless LANDING_URL names a live host. Workers read the origin from
 * LANDING_ORIGIN, which a global setup's environment passes on to them.
 */
export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
	const live = process.env.LANDING_URL
	if (live) {
		process.env.LANDING_ORIGIN = new URL(live).origin
		return undefined
	}
	const server = await serveDist(new URL("../../dist", import.meta.url).pathname)
	process.env.LANDING_ORIGIN = server.origin
	return () => server.close()
}
