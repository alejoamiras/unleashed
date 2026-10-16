# Phase 1 — The AZTEC row in the picker

- The row is synthesized in `manifestCatalog()` from `FUEL_ASSET`, ahead of the manifest tokens, and skipped on a placeholder network. Its name takes the chain from `NETWORK.viemChain.name`, the only place the app may read a chain name.
- `useTokenCatalog.test.ts` mocks `@/contracts/bridge-generation` field by field, so it gained a `FUEL_ASSET` getter. Every index-based assertion moved by one (`HEAD = manifest tokens + 1`).
- The jsdom smoke stubs `discoverFuelRoute`, so the AZTEC case sets `{ kind: "identity" }` itself. Route discovery's own identity branch is unit-tested in bridge-core.
- `AddressesView.test.ts` timed out in two full runs of `test:tools` while the host's load average sat above 200 on 192 cores (other sessions). It calls `vi.resetModules()` and re-imports the view in every case, about 3.4 s alone against the 5 s limit. It does not import the catalog. It passed alone, and the third full run passed clean.

Gate: `bun run lint` exit 0 (2 pre-existing infos); `bun run typecheck:all` exit 0; `bun run test:tools` 109 files, 1643 tests passed; `bun run --cwd apps/tools test:e2e` 3 files, 29 tests passed.
