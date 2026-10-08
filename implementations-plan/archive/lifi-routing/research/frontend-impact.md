# Research: frontend and core-library impact

Round-1 read of apps/tools and packages/bridge-core. File references are repo-relative; line numbers approximate.

## What is computable before the source-chain signature (H)

Claim salt (`Fr.random()`, `useSend.ts`), secret + secretHash (`claim-secret.ts`, `prepareSecrets`), fuel salt + `deriveBridgeSecret` hash, the portal (`predictPortal`, `send-flow.ts`), the record id (= secretHash). Not computable: leaf index, message hash (includes the leaf), and the exact delivered amount if the route is variable.

## Leaf discovery today vs needed

- Today: the app knows its own Ethereum tx hash; `readSendReceiptLeaves` (`send-flow.ts`) reads the router's `Bridge`/`BridgeWithFuel` events filtered by emitter = router; it never reads Inbox events.
- Needed: the Ethereum tx is sent by a relayer/executor minutes later with an unknown hash. Authoritative source = the portal clone's (or our adapter's) own event matched by `secretHash`, authenticated by recomputing the message hash (`recomputeTokenMessageHash`, `tokenMessageState` in `apps/tools/src/lib/message-nullifier.ts`). LI.FI `/v1/status` (`receiving.txHash`) is an untrusted accelerator.
- Reusable: `deposit-reconcile.ts` chunked `getLogs` loop, `budgetedReads`, `windowStart`, `assertChain`, reorg tip check, `chainEpoch` guard. Not reusable as-is: `verifyCandidate`/`calldataMatches` (require `tx.to === router` and decodable router calldata). The default scan window (`createdAt` minus slack, capped at 50k blocks) needs an explicit start block recorded at source-tx time.
- CSP: mainnet `connect-src` is `'self' data: blob:` only (`network-targets.ts`); any LI.FI API fetch or extra RPC needs a CSP entry.

## Journal / stepper

- `deriveSendDepositStage` (`journal.ts`): `depositing` → `syncing`/`claimable` → `registering` → `claiming` → `done`. Rail phases (`bridge-steps.ts`): `permit, seal, approve, sign, deposit, sync, register, claim, confirm`; runtime steps `granting, sealing, signing, approving, depositing, exiting, unsealing, syncing, sending, confirming, verifying`.
- New persisted facts: `srcChainId`, `srcTxHash`, `provider`/`route`, `expectedMinAmount`, `deadline`, `depositTxHash` optional until found, start block for the scan, terminal `outcome` (`delivered-to-wallet | refunded-src | partial`).
- New stages: `bridging` (source tx sent, no fill yet), `filled`; failure branches as outcomes, never `blocked` (`blocked` is terminal corruption, `journal.ts`). `legRecoveryNeeded`/`reconcileDepositLeg` conflate "no deposit found" with "discard": for an in-flight bridge, none means still waiting.
- Backup schema (`backup.ts`) and validators gain the new fields. Seal stays before the source signature (`openSendRecord` writes + verifies the record first).

## Chain assumptions to split (signing chain vs deposit chain)

`useL1Wallet.ts` builds `publicClient` on `NETWORK.viemChain` with a transport that delegates to the wallet provider — Ethereum reads would follow the wallet's active chain (wrong once the wallet sits on Base). `wrongChain`, `switchL1Network`, `assertL1Chain` (useSend.ts, useTokenSelection.ts, useHubExit.ts), record `chainId`, `deploymentMatches` (useBridgeJournal.ts), backup header, `findDepositTx`, token catalog keyed by `MANIFEST.l1ChainId`. Need an Ethereum read client independent of the wallet (RPC + CSP) and a source-chain wallet client. The Biome rule forbids `viem/chains` in the tools app (chain identity only from `@/lib/network`).

## Failure UX needed

Visible timeline (source tx, ETA, deadline); detection that the Ethereum leg failed and tokens sit in the user's Ethereum wallet (LI.FI `LiFiTransferRecovered` / Transfer to the user); refund detection on the source chain (Across-direct routes only); "retry deposit from Ethereum" reusing the record when no message was created, a fresh salt otherwise; keep the sealed record until the outcome settles.

## Effort (from the frontend agent; M)

L: new adapter (contracts), `useBridgeJournal` wait-for-fill + outcomes, `useSend`/`deposit-flow` source-chain split, wizard + catalog multi-chain (owner sign-off required). M: portal-event reader + hash auth, journal/backup/envelope, reconcile, dual-chain clients, stepper phases, LI.FI client + CSP, refund/fallback UI, tests (incl. a second chain in the browser fixture).

## Rules that bind the UI work

AGENTS.md "UI changes need the owner's sign-off": the plan lists every visible surface; the owner approves in writing; the PR attaches screenshots. "The app is a dApp": only `@aztec-labs/wallet-sdk` standard calls on the critical path.
