# Phase 4 — full-system sandbox smoke (a+b+c together)

**Status: ✅ — ALL FLOWS PASS. The recipient-commitment circuit consumes a real L1→L2 message end-to-end; the relayer + wrong-recipient proofs hold.**

## Result (`deploy-sandbox.ts --smoke`, exit 0)

- ✅ deposit-public via `router.bridge()` → `claim_public` → L2 public balance 100000000.
- ✅ deposit-private via `router.bridge()` (recipient-committed salt) → `claim_private(salt)` self-claim — **the first end-to-end proof the recipient-commitment circuit consumes a real message.**
- ✅ **wrong-recipient claim REJECTED** — `claim_private(recipient=relayer, salt)` for account[0]'s deposit fails to consume (the binding holds; a relayer cannot redirect).
- ✅ **relayer claim PASSED** — account[1] (≠ recipient) submits `claim_private(recipient=account[0], salt)`; funds land at account[0] (F-007 closed).

## Six rc.2 / environment staleness issues fixed to get the sandbox running (deploy-sandbox.ts was stale since the rc.2 bump)

1. **Port 8080 taken** by a pre-existing local service → EADDRINUSE. Moved the node to **18080** (anvil on 8545).
2. **`aztec start --sandbox` gone in rc.2** → the mode is `aztec start --local-network --port … --l1-rpc-urls …` (+ `SEQ_MIN_TX_PER_BLOCK=0`, external anvil).
3. **Account setup**: the stale `getInitialTestAccountsData()` + `createSchnorrAccount` fails "Failed to get a note" on the first fee-paid L2 tx. Fix: `registerInitialLocalNetworkAccountsInWallet(ewallet)` (returns the genesis-funded accounts; `accounts[0]`=from, `accounts[1]`=relayer).
4. **Fee ceiling**: rc.2 raised the L2 base fee ~4 orders of magnitude → setup txs reject unless `gasSettings: { maxFeesPerGas: new GasFees(1e13, 1e13) }`.
5. **Tx status**: L2 deploys need `wait: { waitForStatus: TxStatus.CHECKPOINTED }` (a `PROPOSED` deploy isn't queryable → "Contract is not deployed" on the next call). Claims use the lighter `PROPOSED`.
6. **Deploy args**: `salt` + `universalDeploy` are CONSTRUCTION-time args to `Contract.deploy(...)`, NOT `.send()` options (passing to `.send()` is silently ignored → the deploy lands at a different address than the computed instance).
- Plus **Permit2 nonce reuse**: the anvil L1 state persists across reruns (the node is bound to it, can't reset), so use `Fr.random().toBigInt()` per deposit — a sequential 0,1,2 collides with a prior run → `InvalidNonce (0x756688fe)`.

## THE blocker (codex unblocked it — session 019f3806)

Symptom: `claim_public/private` **SIMULATES with revertCode 0** (message looks consumable) but the `.send()` fails "**Tried to consume nonexistent L1-to-L2 message**", forever — the message never nullifies, so the tx never lands.

Root cause (codex): **rc.2 mints no empty L2 blocks** (and `SEQ_MIN_TX_PER_BLOCK=0` doesn't change that). After the L1 deposit, the L2 node/PXE **anchor stalls below the message's checkpoint** — the claim builds its membership witness against the anchor, which never advances, so the real proof fails even though the optimistic pre-send simulation passes. It is NOT a wait-status or leaf-index issue (leaf index 48128 was correct all along).

Fix: `waitForL1ToL2Message(node, messageHash, forceBlock)` — polls `node.getL1ToL2MessageCheckpoint` for the message checkpoint, then submits a cheap `forceBlock` tx (a 0-amount `token.transfer_public_to_private(from, from, 0, 0)`, balance-independent) each poll until `getBlockData("latest").checkpointNumber >= msgCheckpoint`. `runRouterDeposit` now returns `messageHashHex` (the router `Bridge` event `key`). With this, the anchor advances (checkpoint 48→claimable in ~16s) and every claim lands.

## Changes

- `packages/bridge-core/scripts/deploy-sandbox.ts` — modernized for rc.2 `--local-network` (6 fixes above) + the `--smoke` block rewritten to the router path + recipient-committed claims + relayer/wrong-recipient + `waitForL1ToL2Message`/`forceBlock`. The stale withdraw-smoke was dropped (uses the removed `deployer` manager + old portal args; withdraws are covered by the bridge-core tests).
- `packages/bridge-core/src/flows.ts` — `runRouterDeposit` returns `messageHashHex` (the `Bridge` event `key`).

## Gate — RESULT

`bun run --cwd packages/bridge-core deploy:sandbox --smoke` → all legs PASSED (exit 0). `bun run --cwd packages/bridge-core test` 136 passed · typecheck clean · lint clean.

## Note for Phase 7 (live canaries)

The live testnet has real block production (no forceBlock needed), but the leaf-index-from-`Bridge`-event + the salt-based claim + the relayer/wrong-recipient sequence are all proven here. The relayer script (`relay-claim-testnet.ts`) can reuse the `submitPrivateClaim` + wait pattern established in this smoke.
