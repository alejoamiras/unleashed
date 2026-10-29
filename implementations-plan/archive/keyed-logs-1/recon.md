# keyed-logs-1: recon

Base: `main` 1f5455f. One Sonnet reuse sweep plus direct reads by the planner.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Replace keyed env values in text | `apps/tools/scripts/deploy-config.ts:121-132` (`SECRET_ENV`, `redactSecrets`) | adapt: lift into bridge-core, widen the name list |
| Route SDK log lines through redaction | `deploy-config.ts:134-170` (`LEVELS`, `readable`, `installRedactedLogging` on `overwriteLoggingStream`) | reuse as-is, moved |
| Print a keyed run's failure redacted | `apps/tools/scripts/deploy.ts:198-205` | adapt into one shared entry (`runKeyed`) |
| Child-process test of a real SDK retry | `apps/tools/scripts/deploy-config.test.ts:94-129` | adapt: moves to bridge-core, drives `runKeyed` |
| Source-scanning CI guard | `scripts/ci-cd/node-keys.test.ts` (git ls-files, `path: count` failures, synthetic strings built at run time) | pattern for the new sibling guard |
| Node-only helper home | flat `packages/bridge-core/scripts/script-*.ts`, subpath exports such as `./wallet-store` | new `scripts/keyed-run.ts`, `./keyed-run` export |
| Fixed-message node RPC | `src/drpc-node.ts` `postNodeRpc`, `readNodeRpcBody` | reuse; complementary, no change |
| Other redactors | `src/relay-claim.ts:84` `redactDescriptorForLog` (object fields); `scripts/run.ts` `RunError` (argv) | unrelated; untouched |

Absence trail: `grep -Ei 'redact|scrub|\bmask|sanitiz|<DRPC|safeError|describeError'` over `packages/`, `scripts/`,
`apps/tools/scripts`, `.github` (ts, mjs, yml, sh). Other hits are EVM bytecode masking (`verify-l1.ts:601-657`) and
word sanitizing (`src/register-hash.ts:34`, `src/erc20.ts`). Only `deploy-config.ts` and `deploy.ts` import
`@aztec-labs/foundation/log`.

## Keyed composers (`requireDrpcNodeUrl(` outside its definition)

| File | Node client the URL reaches | Entry today |
|---|---|---|
| `apps/tools/scripts/deploy-config.ts` (`nodeUrlFor`, library) | SDK, through `deploy.ts` | `deploy.ts`: redacted logging + redacted failure |
| `bridge-core/scripts/check-fpc-version.ts` | `postNodeRpc` only | `isMain` guard, prints `err.message` |
| `deploy-generation.ts` | SDK (`createNode`, `createL2Wallet`) | `main().catch(console.error(e))` |
| `deploy-private-fpc-mainnet.ts` | SDK, through `deploy-canonical-private-fpc.ts` | top-level `await`, no catch |
| `deposit-testnet.ts`, `fee-juice-canary-testnet.ts`, `fuel-testnet.ts`, `smoke-existing-testnet.ts`, `smoke-fuel-existing-testnet.ts`, `drip-canary-testnet.ts` | SDK | `main().catch(console.error(e))` |
| `fpc-dust-canary-mainnet.ts` | SDK and `postNodeRpc` | `main().catch(console.error(e))`; prints a caught SDK message mid-run (`:165`) |
| `lifi-canary-testnet.ts` | SDK, through `openCanaryL2` | `import.meta.main`, prints message, exits 0 on success |
| `live-intent.ts` | `postNodeRpc`, and SDK in `reportHubBindings` (`:847`) | `isMain`, `dispatch.catch`, prints message |
| `relay-claim-testnet.ts` | SDK | `main().catch`, message only, by design (`:163`) |

## Observed behaviour (demonstrated)

- The SDK's retry logs the host on every failed attempt: `foundation/dest/retry/index.js:65`
  (`Error while retrying JsonRpcClient request to ${host}`), and the thrown error names it
  (`json-rpc/client/fetch.js:33,47`). The existing child-process test passes at 1f5455f (1.2 s).
- `overwriteLoggingStream` replaces the root logger's stream (`pino-logger.js:351`); `wallets`, `pxe`, `aztec.js` and
  `stdlib` 6.0.0 start no worker thread (`grep 'new Worker(|worker_threads'` over their `dest/`: none).
- Bun 1.4.2 (`scratch` probe): `console.error` never calls `process.stderr.write`, and a top-level-await rejection is
  printed natively, source excerpt included, even with an `unhandledRejection` handler. A stream wrapper cannot
  redact script prints; only the code that prints can.
- viem 2.57.1 prints the RPC URL in error text (`errors/request.ts:35,84,112`); `getUrl` strips only userinfo, so a
  path-keyed L1 URL appears whole.

## Keyed names

Templates (`op://`, non-archived): `DRPC_API_KEY`, `PRIVATE_KEY`, `SEPOLIA_RPC_URL`, `ETH_RPC_URL`,
`BRIDGE_DEPLOYER_SECRET_TESTNET`, `DEPLOYER_SECRET_KEY`, `DEPLOYER_SALT`, `FUNDING_PRIVATE_KEY`,
`CLOUDFLARE_API_TOKEN`, `RELAYER_PRIVATE_KEY`. Read by scripts outside any template: `MAINNET_PRIVATE_KEY`,
`BRIDGE_DEPLOYER_SECRET_MAINNET`, `CANARY_PRIVATE_KEY`, `RELAYER_L2_SECRET_KEY`, `BASE_SEPOLIA_RPC_URL`,
`INTENT_SECOND_AZTEC_RPC`, `DEPLOYER_SECRET`. Public: `DEPLOYER_SALT` (a deployed account's salt; short values),
`BRIDGE_DEPLOYER_PREFIX_*` (printable prefixes).

## Collisions

- sdk-1 a2 moves bridge-core `src/` modules and edits their importers' import lines; `drpc-node` and `scripts/` stay.
  Expect import-block conflicts only; merge `origin/main` before the PR.
- `deploy-config.ts` and `deploy.ts` landed in #42; their local helper is what moves.
- `fpc-dust-canary-mainnet.ts` `main` is a complexity exception (accepted 23); the change must not raise it.
- Open issues: only #46 matches `redact`; closed known limits (#34, #35, #39) are unrelated.
- Out of scope, seen: `verify-l1.ts`, `pause-factory.ts`, `fill-testnet.ts` run keyed L1 URLs and print viem messages,
  but compose no node URL.
