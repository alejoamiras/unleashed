# Phase 2 ✓ — signing-key-root + FPC canonical

## Gate result: ✅ all green
`typecheck:all` exit 0 · `test:all` exit 0 (bridge-core 128 + the rest) · `lint` exit 0 · the faucet build exit 0.

## What shipped

- **The ONE derivation helper** is the wallet's, exported by `@alejoamiras/nulo-wallet-crypto`: `deriveSigningKeyFromSeed(seed) = sha512ToGrumpkinScalar([seed, DomainSeparator.IVSK_M])` (D7 — upstream's removed construction verbatim; `IVSK_M = 2747825907`) + `deriveNuloAccountKeys(seed)` → `{signingKey, secretKey}` via upstream `deriveSecretKeyFromSigningKey`. The faucet gained `@alejoamiras/nulo-wallet-crypto`.
- **The script sites** migrated to the two-step through the helper (faucet `deploy.ts` restructured `DeployerKeys`; 6 bridge-core scripts). `deploy-sandbox.ts` untouched (uses upstream `getInitialTestAccountsData`, already 5.0.0-shaped).
- **PrivateFPC canonical re-root**: pin `0x0d4b2c28…` (rc-era operator salt 0) → **`0x257aa870…efc86e9` at canonical salt `0x…01`** across bridge-core (`PRIVATE_FPC_ADDRESS` + new `PRIVATE_FPC_SALT`), the wallet's discovery (was salt 0, the false-address bug codex 3 caught), and the deploy script. New committed descriptor `private-fpc-canonical.json` (address+salt+deployer+aztecVersion+**artifactSha256** `6c0cd8bc…`) machine-asserted by the tripwire test (derivation from the installed artifact at the canonical salt == the canonical address — passed empirically, cross-check #1) . **`check-fpc-version.ts` hardened**: exact full-version (no prerelease-stripping — the old major-only compare was false-green across rc↔stable), artifact digest, descriptor coherence, live `node_getContract` class check with RPC-error≠absence. **Run live: GREEN** (node 5.0.0, digest match, address clean-absent on rollup 1821665230 — deploy owed in Phase 5).

## Gotchas

- biome 2.5.2 (in-range refresh) reformatted a multi-line throw — run `biome format --write` on touched files before committing.

LESSONS_FILE=implementations-plan/archive/aztec-5.0.0-stable/lessons/phase-2.md
