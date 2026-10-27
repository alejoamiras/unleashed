# Phase 4: LI.FI client, builders, decoder, fuel quotes, discovery

**Verdict: done.** The core library can quote, build, verify and track a LI.FI-routed deposit end to end from
read-only data. Three agents wrote it in parallel on one tree: the decoder, builders and Stargate codecs; the
client, fetch, fuel quotes, source chains and address book; discovery and the shared chain reads. The parent
integrated and ran the gate.

## Facts the next phases rely on

- **`capped-fetch.ts`** is the one bounded HTTP read: no redirects (asked of the runtime, and any 3xx it is handed
  is refused), a byte cap on the running total while the body streams, one deadline over request and body. It
  never throws, and it returns the status without judging it. `token-list.ts` reads through it.
- **`lifi-api.ts`** is keyless.
  - Schemas keep exactly the fields the decoder, the fuel quote and the UI read. A quote that answers another
    request is refused, naming the first field that differs. A 404 keeps LI.FI's per-path reasons.
  - `/v1/status` matches a caller-chosen `transactionId` across chains, so an answer counts only when it is bound
    to the queried source transaction. Status is an accelerator; discovery decides.
  - Same-chain quotes send `integrator=unleashed` and `allowExchanges=nordstern,sushiswap` (D9). `fuel-quote.ts`
    and the decoder refuse a fuel route whose tool or any swap step is outside that list.
- **`lifi-addresses.ts`** is a third-party constant book (like Permit2), taken from the pinned lifinance/contracts
  commit, with runtime code hashes the live suite checks. A manifest enables sources; it never names these.
- **`source-chains.ts`** is viem-free. Mainnet sources carry no default RPC, so the app must supply one.
- **`verifyRoute` / `verifyComposeMessage`.**
  - They decode the exact bytes the user signs and never re-encode provider bytes for signing. Each decoded layer
    must equal the canonical encoding of its own values, so no byte escapes the comparison.
  - Every decoded leaf is either policed (`ROUTE_FIELD_POLICY`: `equal`, `atMost`, `atLeast`, `within`, `oneOf`)
    or listed in `ROUTE_UNPOLICED` with its reason. The mutation suite walks every leaf of every recorded route,
    outer and nested, and expects a refusal under that leaf's own name.
  - The ERC-20 approval travels in `RouteTx` and is verified with the call.
  - Stargate: `minAmountLD` must be at least `minReceived`, and the destination step's `fromAmount` must sit in
    `[minReceived, minAmountLD]` in the quote and in `[T, amountLD]` in a delivered compose message. LayerZero
    ordered-execution and native-drop options are refused. `nativeFee` is held under the caller's
    `stargateFeeCeiling` of the pool's own `quoteSend`.
  - Unpoliced on purpose: the venue calls inside the fuel swap (LI.FI's allow-list and the router's floor bound
    them), labels (`bridge`, `referrer`, `integrator`, `transactionId`), lzReceive gas (it only raises a capped
    fee), and `requiresDeposit` (the Executor ignores it).
- **`across-v4.ts`** reproduces the fork-proven vector byte for byte, and every recorded router variant from its
  expectation alone.
- **Discovery** (`crosschain-discovery.ts` over `chain-scan.ts`).
  - Authority is the rail's transport identity: Across `FundsDeposited` and its relay hash (pinned to the deployed
    Sepolia SpokePool's `getV3RelayHash`), Stargate `OFTSent` and its guid. A secret hash never decides.
  - Only pinned emitters count. The Inbox's `MessageSent` shape is chosen per network (Phase 2 fact).
  - A scan answers for its whole window or throws `ScanIncomplete`: a chain switch, a reorg during the scan, a node
    behind the record, a budget or deadline overrun. Callers report `incomplete` and retry, never absence. Nothing
    is cached between scans.
  - `not-sent` comes only from a reverted source receipt whose `from` is the record's signer. Absence is `pending`.
  - A provisional outcome is replaced when a later scan finds the deposit, which closes Phase 3's reorg item.
  - `apps/tools` `deposit-reconcile.ts` now reads through `chain-scan.ts`.

## Open

- **No committed Stargate destination receipt.** Discovery's Stargate cells use a `ComposeDelivered` built from
  Phase 2's compose capture. A real one exists only after a mainnet deposit, which this plan does not make.
- **The older mainnet Inbox's `FeeJuicePortal` L1 sender is unverified.** Check it before any mainnet discovery
  claims a direct-gas deposit.
- **No scan cursor.** Each discovery rescans its window. That is fine for one record; revisit if the dock polls many.
- **Contradictory facts yield `incomplete`,** not a verdict.
- **A slow-fill request past the deadline counts as expired.**
- **Arc 4** (carried from Phase 3): restore and the dock's `storedJournalIds` read `JOURNAL_KEY` only; the label
  for an uncertain wallet reply; extra deposits have no claim marker.

## Attempts

1. Three of the client agent's tests pinned values from the first mainnet recording and broke when Phase 2
   re-recorded with the integrator. They now derive every value from the fixtures.
2. `lifi-gas.test.ts` gained an allow-list check: it fails when a recorded route uses a venue the forks have not
   proven, so a re-record that drifts to a new venue cannot pass silently.
3. **Gate.** G0 TypeScript: lint, `typecheck:all`, `test:all`, `lint:actions`, `test:ci-gating`, all exit 0.
   `bun run --cwd packages/bridge-core test`: 67 files, 643 passed, 11 skipped (the opt-in live tests).
   `LIFI_LIVE=1 bun run --cwd packages/bridge-core test -- lifi-addresses lifi-api`: 2 files, 31 passed. The
   contract half of G0 is unchanged since Phase 3: no contract file moved.
