import type { ComponentResolverFunction } from "unplugin-vue-components"

/**
 * `@unleashed/design` layout primitives the tools app uses as bare tags. Every other component is
 * imported explicitly.
 *
 * The set contains ONLY tags that are actually used as bare tags today (so it stays in lockstep with
 * the committed `src/types/components.d.ts` — an unused entry would make `vue-tsc` reject a future bare
 * tag until the next build regenerates the dts). Add a primitive here the moment a template uses it as
 * a bare tag, then `bun run build` to regenerate + commit the dts (e.g. Text/Icon, or Tag/Badge if a
 * status-pill swap ever wins its visual check).
 */
export const DESIGN_COMPONENTS = new Set(["Flex"])

export function designResolver(): ComponentResolverFunction {
	return (name: string) => {
		if (DESIGN_COMPONENTS.has(name)) return { name, from: "@unleashed/design" }
	}
}
