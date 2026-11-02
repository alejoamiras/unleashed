# Phase 1: rename and scope markers

- Text replace: 208 files (bun.lock excluded), 402 occurrences. `bun install --frozen-lockfile` then failed ("lockfile had changes, but lockfile is frozen"), as expected.
- `bun install` (Bun 1.4.2): `bun.lock` moved only the five SDK entries (three re-sorted inside dependency maps, since `-` sorts before `/`); no version re-resolved, and the 7-day gate refused nothing. I1 held.
- I2 did NOT hold: Bun 1.4.2's isolated linker kept `{apps/tools,packages/bridge-core,packages/testnet-relayer}/node_modules/@unleashed/sdk`, still linked to `packages/sdk`, so a missed old import would have resolved locally. Removing every `node_modules` and running `bun install --frozen-lockfile` (what CI does) left none.
- Biome rewrapped exactly the 10 files recon listed.
- Mutation 1: deleting `packages/sdk/src/**` from `pr-tools-e2e.yml` fails `behavior-gating.test.ts` ("tools-e2e: dep lib 'sdk' src must be gated"). Control: the old `startsWith("@unleashed/")` filter passes 12/12 under the same mutation, so it would have lost the SDK silently. Reverted.
- Mutation 2: `import "@unleashed-systems/sdk"` in `packages/design/src/core/icons.ts` fails `biome check` (noRestrictedImports); `import "@unleashed/legal"` still fails too. Reverted.
