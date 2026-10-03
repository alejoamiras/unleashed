# Phase 8 — faucet tooling, no cutover

## What changed
- **Catalog.** `packages/bridge-core/src/faucet-catalog.ts` is exported from `"."`. `FAUCET_TOKENS` holds SIGNAL (6 dp, salt 4246) and NOISE (18 dp, salt 4247), plus `FaucetToken` and `FaucetSymbol`. It has no dependencies. The comment retires salts 4242–4245.
- **Records module.** `apps/tools/src/contracts/deployment-records.ts` imports no JSON. It holds the record types (`constructorArgs.symbol` is now `string`), `rebuildTokenInstanceFrom`, `rebuildDripperInstanceFrom` and a new `checkDeploymentRecords`.
  - `deployments.ts` re-exports all of them, so the live consumers are unchanged.
- **Data-driven checks.** `checkDeploymentRecords` checks every record in the file, whatever its symbols. The Dripper and each token must re-derive to their committed addresses, and each token's minter must be this file's Dripper. Symbols must be unique, since the app looks tokens up by symbol. A file with no tokens fails.
  - `verify-deployments.ts` prints those checks; its hardcoded symbols are gone.
  - `drip-canary-testnet.ts` rebuilds and asserts every token (address and minter), then drips one whole token of each and checks each balance delta. It used to drip only one token.
- **Deploy config.** `deploy-config.ts` takes its tokens from `FAUCET_TOKENS`, and `DripTokenConfig` is the catalog's element type. `TOOLS_DEPLOY_DATA_DIR` sets the deployer's PXE store and must be absolute; a relative path throws. The type at `deploy.ts:103` is `FaucetSymbol`.
- **Unchanged.** App consumers, the sandbox catalog and the live JSON stay on the old tokens until the phase 9 cutover.

## Dry run
`env -u AZTEC_NODE_URL -u DEPLOYER_SECRET -u DEPLOYER_SECRET_KEY -u DEPLOYER_SALT bun --no-env-file apps/tools/scripts/deploy.ts --network testnet --dry-run` exits 0 with no keys:

| Record | Address |
|---|---|
| SIGNAL (salt 4246, 6 dp) | `0x1bde26125447c64ff01ef8caf0c2d8942eacce75670d2903f4b77120e8636e74` |
| NOISE (salt 4247, 18 dp) | `0x295d451810ed3f0e6c2620d2cc299438ee47265c094528b2da3abc75166d4dad` |
| Dripper (salt 1337, unchanged) | `0x064399d44c7ba2380dc7f8e8a8395189879ab7cc71c1ac5c4ca63a35a25815fd` |

The dry-run records also pass `verify-deployments.ts --config <dry-run json>`: all five checks OK (Dripper, both tokens, both minters).

## Tests
- `deployments-records.test.ts` now runs in the node environment. It turned out that bb.js's sync poseidon initialises there; only jsdom lacks the WASM init. The file imports from the records module and adds three tests:
  - the live file passes every check;
  - a tampered token address fails exactly that token;
  - a foreign minter fails the minter check, and an empty token list fails.
- `deploy-config.test.ts` is new. The catalog lands in an absolute data directory, and a relative one throws.

## Attempts
- **The field modulus.** A test's fake minter `0x3434…` exceeds the BN254 field modulus (`0x3064…`), so it threw before the check ran. It is now `0x0404…`.

## Gate
- **PG PASS.** Lint (complexity baseline OK), `typecheck:all` exit 0 in all three packages, `test:all` exit 0, and the jsdom smoke.
- **BG PASS.** Both builds pass `verify:build-target`, contain no `data:font`, and produce `_headers` identical to `main`.
- **`verify:deployments` on the old live file**, now data-driven: the Dripper, the first faucet token and its minter, and the second faucet token and its minter are all OK.
- **Tamper test.** `deployments-records.test.ts` shows that a record with a tampered address fails exactly its own check.
