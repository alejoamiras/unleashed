# Phase 1 — Resolver infrastructure + bare-tag proof

**Status:** ✓ green. Gate: typecheck 0 · test 397/397 · lint 0 (1171 files) · build ✓ · test:e2e 14/14.

## What shipped
- `packages/faucet/scripts/design-resolver.ts` — primitives-only `DESIGN_COMPONENTS` (`Flex`, `Text`, `Icon`) + `designResolver()`.
- `packages/faucet/scripts/components-plugin.ts` — shared `componentsPlugin({ dts })` factory (`dirs: []`, resolver-only) consumed by all three configs (anti-drift).
- `packages/faucet/scripts/design-resolver.test.ts` — no-shadow guard (no local SFC name collides) + resolve/ignore assertions.
- Wired the factory into `vite.config.ts` (`dts: "src/types/components.d.ts"`) + `vitest.config.ts` + `vitest.e2e.config.ts` (`dts: false`).
- `package.json` += `unplugin-vue-components@^32.0.0`; one normal `bun install` recorded the workspace edge (no fresh download — already resolved).
- `biome.json` += `!**/packages/faucet/src/types` exclude (generated dts).
- **Proof swap:** `VerificationModal.vue` `.actions` `<div>` → bare `<Flex gap="12" justify="end">` (full swap — `.actions` was pure layout, rule deleted). `VerificationModal.test.ts` (which mounts the real subtree, no stubs) stayed green → proves the vitest resolver fires; the build + smokes prove rollup + e2e resolution.
- Generated + committed `src/types/components.d.ts`.

## Learnings / decisions
- **`ComponentResolverFunction`, not `ComponentResolver`.** vue-tsc rejected calling `designResolver()` directly in the test because `ComponentResolver` is a union whose object variant has no call signature. Narrowed the return type to the function variant — more precise than the looser `ComponentResolver`, and `useComponents({ resolvers })` still accepts it (a function IS a `ComponentResolver`). Acceptable divergence from the Nulo wallet's resolver (D3 — faucet owns its copy).
- **Generated dts is `@ts-nocheck`'d** and also declares `RouterLink`/`RouterView` (unplugin's standard vue-router boilerplate). Harmless — the `@ts-nocheck` header means vue-tsc never type-resolves the `import('vue-router')` reference even though the faucet has no router. dts confirms only `Flex` from `@unleashed/design` (resolver fired on the one bare tag).
- **`dirs: []` works** — the generated dts contains only the detected bare tag + router boilerplate, no local-component dir-scan (I1 confirmed empirically).
- **biome.json `includes` reformatted multiline** by the formatter (my one-line edit pushed it past `lineWidth: 140`). Ran `biome format --write biome.json`; intentional, kept.
- The 51 lint warnings are the pre-existing repo baseline (none from the new files; grep-confirmed) and don't fail `biome check`.

LESSONS_FILE=implementations-plan/archive/design-system-faucet-adoption/lessons/phase-1.md
