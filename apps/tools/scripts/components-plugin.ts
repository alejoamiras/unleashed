import useComponents from "unplugin-vue-components/vite"
import { designResolver } from "./design-resolver"

/**
 * Single source of the `unplugin-vue-components` setup so `vite.config` and both vitest configs
 * resolve the same bare `@unleashed/design` primitive tags identically — a partial cutover across the three
 * entrypoints is the failure mode this prevents. `dirs: []` = resolver-only (no local dir-scan, so an
 * explicit import or local component always wins and the resolver can't shadow). `dts: false` in the
 * test configs avoids regenerating the declaration file on every run; the build config owns dts.
 */
export function componentsPlugin({ dts }: { dts: string | false }) {
	return useComponents({
		dirs: [],
		resolvers: [designResolver()],
		dts,
	})
}
