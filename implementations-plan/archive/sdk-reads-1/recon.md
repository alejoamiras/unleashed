# Recon: sdk-reads-1

Base: `origin/main` at `97e100e`. One Sonnet reuse sweep plus the planner's own reads and a viem reproducer
(scratch, not committed; its output is quoted below).

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Tell a failed aggregate from one failing token | `apps/tools/src/composables/useEthereumReader.ts:54-65` (`readBalancesOn`: rejects when an entry's error walks to `CallExecutionError`, by `instanceof`) | adapt: the rule moves into `readErc20Balances`, widened (plan D1); the app copy is deleted |
| Match a viem error across viem copies | `packages/bridge-core/src/crosschain-discovery.ts:296-299` (`receiptOrNull`, matched by `name` "since a second viem copy defeats `instanceof`") | reuse the idiom: property checks, no `instanceof` |
| A null read of a logged hash makes a scan incomplete | `crosschain-discovery.ts:413-416` and `:594` (`if (!receipt) throw new ScanIncomplete(...)`) | reuse the idiom in `isRecordCall` and `landed` |
| Turn a failed read into "incomplete" | `packages/sdk/src/execution/chain-scan.ts:10,27-46` (`ScanIncomplete`, `budgetedReads`) | reuse as-is |
| Stub reconcile client | `packages/sdk/src/execution/deposit-reconcile.test.ts:113-152` (`fakeChain`, overridable methods) | reuse as-is |
| Real viem client over a scripted node | `apps/tools/src/composables/useRowBalances.test.ts:~131-160` (`nodeClient`, `custom` transport, `retryCount: 0`) | reuse the shape in `erc20.test.ts` |
| Shared viem-error fixtures | none. Searched `git grep` for `CallExecutionError`, `ContractFunctionExecutionError`, `HttpRequestError` in `*.ts` | build none: a real client over `custom` produces the real errors |
| SDK changelog / docs naming the two functions | none. `packages/sdk` has no CHANGELOG or changesets; `README.md` and `examples/` never name `readErc20Balances` or `findDepositTx` | only the two doc comments change |

## Callers

- `readErc20Balances` (`@unleashed/sdk/protocol`, a public subpath): only `readBalancesOn`. `send-smoke.test.ts:203` and
  `useRowBalances.test.ts:19-23` mock it; the latter's `nodeClient` tests run the real one.
- `readBalancesOn`: `useRowBalances.ts:40` (a rejection keeps the rows already read) and `useTokenSelection.ts:149`
  (a rejection gives `undefined`, "a zero would refuse every amount"). Both already handle a rejection.
- `findDepositTx` (`@unleashed/sdk/internal`, "never published"): `claim-run.ts:223` (a string result throws
  `deposit-not-found` with `search`) and `useSend.ts:184` → `useBridgeJournal.ts:1330-1380` (`"none"` shows "…discard
  this record."). PR #88 removes the app caller and routes the app through `claim-run.ts`; it does not touch
  `deposit-reconcile.ts`.
- Both callers pass a viem `PublicClient` (`useL1Wallet.ts:37`, `network.ts:23` `Reads.l1`).

## Facts from viem 2.57.1 (reproducer, real `createPublicClient` over `custom`)

| `eth_call` answer | every entry's error chain | walks to `CallExecutionError` |
|---|---|---|
| throws HTTP 429 | `ContractFunctionExecutionError(aggregate3) > CallExecutionError > HttpRequestError` | yes |
| JSON-RPC -32603, no data / junk data | `…(aggregate3) > ContractFunctionRevertedError > [AbiErrorSignatureNotFoundError >] CallExecutionError > …` | yes |
| JSON-RPC 3 "execution reverted" | `…(aggregate3) > ContractFunctionRevertedError > CallExecutionError > ExecutionRevertedError` | yes |
| `0x` (no code at the declared Multicall3) | `…(aggregate3) > ContractFunctionZeroDataError > AbiDecodingZeroDataError` | **no** |
| truncated bytes | `…(aggregate3) > AbiDecodingDataSizeTooSmallError` | **no** |
| aggregate ran, one token reverted | that entry only: `ContractFunctionExecutionError(balanceOf) > ContractFunctionRevertedError > RawContractError` | no |

- A failed aggregate gives every entry the same error object; a token's own failure is its own object.
- `getTransaction` and `getTransactionReceipt` reject on a `null` answer (`TransactionNotFoundError`,
  `TransactionReceiptNotFoundError`; `actions/public/getTransaction.ts:151`, `getTransactionReceipt.ts:66`).
- One viem copy is installed (`bun.lock`: `viem@2.57.1` only); the SDK pins it exactly, `apps/tools` takes `^2.52.2`.
- The sandbox installs Multicall3 at the canonical address its chain declares (`apps/tools/src/lib/network.ts:36-39`,
  `packages/bridge-core/scripts/sandbox/deploy.ts:111`).

## Other reads checked (lane "verify first")

No other reconcile read treats a `null` or failed read as a negative answer: `deposit-recovery.ts:77` reads a failed
receipt as `"pending"`, `claim-run.ts:278` as "waiting"; `getBlock`/`getLogs` null answers throw a `TypeError` that
`findDepositTx` rethrows (no `"none"`). Inside `landed`, a receipt whose status is not `success` stays a real negative.

## Collisions

- PR #88 (sdk-1) edits `useSend.ts` and `useBridgeJournal.ts`; this lane edits neither. gen-pins-1 edits the SDK's
  network readers, not these files. Implement after #88 merges; merge `origin/main` before the PR.
- Closed known limits nearby: #43 (search window about a week), #74 (refresh right after a mint), #87 (keyless
  history). None overlaps.
