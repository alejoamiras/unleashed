/**
 * Shared `test` options every workspace vitest config spreads in. A plain object with no
 * imports on purpose: it resolves identically under the hoisted and the isolated linker.
 */
export const sharedTest = {
	// STOPGAP until the installed vitest contains vitest-dev/vitest#10363 (≥ 5.0.0-beta.3).
	// Bun's ES-module namespace objects answer `"__esModule" in ns` (Node: false), so vitest 4's
	// default interop replaces an externalized module by its `default` — zod@4's default IS a
	// namespace and `z` vanishes. Off, named exports of CJS deps follow each runtime's own loader
	// (no vitest fallback); the Node soak baselines prove nothing here depends on that fallback.
	// Retire: delete this key and re-run the Bun soak matrix (scripts/ci-cd/test-soak).
	deps: { interopDefault: false },
} as const
