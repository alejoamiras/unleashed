# Holonym Bridge Flows, Status Model & Recovery Research

## Purpose

Document the end-to-end L1→L2 and L2→L1 bridge flows from the Holonym reference codebase
so that `@unleashed/bridge-core` can replicate the happy-path mechanics, improve the
loading-bar UX (real "N blocks remaining" vs today's step-counter), and implement
localStorage-only recovery (dropping Holonym's server layer).

Pinned Aztec version: 4.2.0.

---

## Key files

| Role | File |
|---|---|
| SDK entry point (class) | [holonym] `bridge-sdk/src/index.ts` |
| L1 deposit + withdraw encode | [holonym] `bridge-sdk/src/l1.ts` |
| L2 claim + withdraw initiate | [holonym] `bridge-sdk/src/l2.ts` |
| Shared types | [holonym] `bridge-sdk/src/types.ts` |
| Helpers/converters | [holonym] `bridge-sdk/src/utils.ts` |
| L1 step functions (deposit path) | [holonym] `frontend/src/hooks/bridge/bridgeL1ToL2.ts` |
| L2 step functions (withdraw path) | [holonym] `frontend/src/hooks/bridge/bridgeL2ToL1.ts` |
| Shared bridge utilities | [holonym] `frontend/src/hooks/bridge/bridgeUtils.ts` |
| Resume L1→L2 hook | [holonym] `frontend/src/hooks/useResumeL1BridgeToL2.ts` |
| Resume L2→L1 hook | [holonym] `frontend/src/hooks/useResumeL2WithdrawToL1.ts` |
| L2 operations + full L2→L1 flow | [holonym] `frontend/src/hooks/useL2Operations.ts` |
| Bridge operations activity list | [holonym] `frontend/src/hooks/useBridgeOperations.ts` |
| Zustand bridge store | [holonym] `frontend/src/stores/bridgeStore.ts` |
| Segment progress bar | [holonym] `frontend/src/components/LoadingStepsBars.tsx` |
| Aggregate progress bar | [holonym] `frontend/src/components/LoadingBar.tsx` |

---

## L1→L2 flow + timing gate

### Actors and artefacts

- **L1 TokenPortal** (Solidity): accepts ERC-20 deposits, emits `DepositToAztecPublic` or
  `DepositToAztecPrivate` events containing two critical fields:
  - `key` (`bytes32`) — the canonical `messageHash` of the L1→L2 cross-chain message
  - `index` (`uint256`) — the Inbox leaf index (the position in the L1 Inbox tree)
- **Aztec Inbox** (L1): receives the message hash when the Portal calls `sendL2Message`.
- **Aztec Rollup** (L2): periodically syncs the Inbox and includes messages in L2 blocks.
- **L2 TokenBridge** contract: exposes `claim_public` / `claim_private`.

### Step-by-step (happy path)

1. **Validate & capture baseline** — call `aztecNode.getBlockNumber()` and
   `publicClient.getBlockNumber()` before the deposit to snapshot current L1 and L2 heights.
   Both block numbers go into localStorage immediately (recovery anchor).

2. **Generate `claimSecret`** — random `Fr`. Compute `claimSecretHash = poseidon2(claimSecret)`.
   In Holonym, secret-hash computation is done server-side (via `/api/compute-secret-hash`) to
   avoid `SharedArrayBuffer` restriction. **Unleashed drops the server**: `computeSecretHash` from
   `@aztec/aztec.js/crypto` can be called directly in a browser if the cross-origin headers are
   set, or via a Web Worker.

3. **ERC-20 approval** — `approve(portal, amount)` or Permit2 `approve(PERMIT2, maxUint256)`.
   Wait for receipt.

4. **Deposit tx** — call `TokenPortal.depositToAztecPublic(recipient, amount, secretHash)` (or
   `depositToAztecPrivate(amount, secretHash)`). Wait for receipt.

5. **Extract `messageHash` + `messageLeafIndex`** from the receipt logs:
   - Holonym uses `extractEvent` from `@aztec/ethereum/utils` on the `DepositToAztecPublic` event.
   - The `key` field is the `messageHash`; the `index` field is the `messageLeafIndex`.
   - Fee-adjusted amount: Holonym's custom portal deducts a fee before emitting the event, so the
     `amount` field in the event is `amountAfterFee`. The L2 claim **must** use this post-fee amount
     or the content hash will not match.

6. **Poll for L1→L2 message sync** — call
   `aztecNode.getL1ToL2MessageCheckpoint(Fr.fromString(messageHash))` every 30 s (up to 40 min).
   The method returns `undefined` while the message is not yet in the Aztec state tree; it returns
   a checkpoint value (the L2 block that included the message) once synced.
   - This is the **definitive timing gate**: until `getL1ToL2MessageCheckpoint` returns a value,
     the L2 claim cannot succeed.
   - After sync is confirmed, Holonym adds a **2-minute buffer wait** so the wallet's own PXE node
     catches up (it may lag the Aztec public node).

7. **Claim on L2** — call `TokenBridge.claim_public(recipient, amountAfterFee, claimSecret, messageLeafIndex)`.
   - The `messageLeafIndex` passed to the claim is the index from the Inbox tree (extracted in step 5).
   - Holonym skips `simulateTx` and calls `sendTx` directly because the PXE's local message tree
     may lag; the sequencer has the authoritative state.
   - On "nonexistent L1-to-L2 message" errors, retry up to 5 times with 2-minute delays.

### Brute-force leaf index

If `messageLeafIndex` was not captured (e.g., page crashed between steps 4 and 5, or the event
was decoded from a legacy ABI that omits the `index` field), Holonym falls back to iterating
`messageLeafIndex = 0, 1, 2, …, 63` and sending a claim attempt at each index until one succeeds.
The sequencer reverts on a wrong index, so incorrect attempts are cheap (no state change, just gas).

This is a last-resort mechanism. The normal path always captures `messageLeafIndex` from the event.

---

## L2→L1 flow + timing gate

### Actors and artefacts

- **L2 TokenBridge** contract: `exit_to_l1_public(recipient, amount, callerOnL1, nonce)` burns the
  caller's L2 balance and emits an L2→L1 message into the L2 outbox.
- **L1 Rollup** contract (Solidity): `getProvenCheckpointNumber()` returns the highest L2 block
  number whose proof has been verified on L1. Messages from blocks up to this number are consumable.
- **L1 TokenPortal**: `withdraw(recipient, amount, withCaller, epoch, messageIndex, siblingPath)`.

### Step-by-step (happy path)

1. **Validate & capture** — same block-number snapshot pattern as L1→L2. `l2BlockNumberBeforeTx`
   is stored; it lets recovery scan forward from a known baseline.

2. **Generate `nonce`** — random `Fr`. This is the nonce passed to `exit_to_l1_public` / `burn_public`.
   The nonce is needed only for the L2 burn step. Recovery of the L1 withdraw does **not** require
   the nonce (the message leaf is derived from `l1Recipient, amount, l2BridgeAddress, portalAddress,
   rollupVersion, chainId` — no nonce).

3. **`burn_public` + `exit_to_l1_public`** — Holonym issues two L2 calls:
   a. `TokenBridge.burn_public(owner, amount, nonce)` via `executeCallWithAuthWit` (sets an auth witness
      so the bridge is permitted to burn).
   b. `TokenBridge.exit_to_l1_public(l1Recipient, amount, EthAddress.ZERO, nonce)` — this enqueues
      the L2→L1 message.
   The `l2BlockNumber` of the exit transaction is captured from `result.blockNumber` (or polled from
   `aztecNode.getTxReceipt`).
   **After this step, tokens are burned on L2. This is the point of no return.** Holonym marks a
   boolean `burnConfirmed = true` after which errors never set `status = 'failed'`.

4. **Compute membership witness** — call `computeL2ToL1MembershipWitness(aztecNode, msgLeaf, txHash)`.
   This is a 4.1.0+ API that accepts the `TxHash` directly and resolves the epoch/block/tx structure
   internally. Returns:
   - `leafIndex` — position in the L2→L1 message tree for the block's epoch
   - `siblingPath` — Merkle proof bytes
   - `epochNumber` — the epoch (NOT the block number) used in the L1 `withdraw` call

5. **Wait for L2 block proven** — poll L1 Rollup's `getProvenCheckpointNumber()` every 2 minutes (up
   to 50 minutes) until the returned value ≥ `blockNumberForProof`. This is the **definitive timing
   gate for L2→L1**: the L1 Outbox only accepts a message once the containing L2 block is proven.
   - Fallback: if `rollupAddress` is unavailable or the poll fails, wait a fixed 40 minutes.
   - `getProvenCheckpointNumber` is read from the L1 Rollup contract via `publicClient.readContract`.

6. **30-second final buffer** — let the Rollup proof settle before sending the L1 tx.

7. **`TokenPortal.withdraw(recipient, amount, false, epoch, leafIndex, siblingPath)`** — the L1 tx
   that transfers ERC-20 from the Portal to the recipient. Uses `epoch` (not `l2BlockNumber`) because
   the L1 contract parameters shifted to epoch-based indexing in 4.1.x.

### Block proven vs block finalized distinction

Aztec 4.x separates **sequenced** (block included in rollup), **proven** (ZK proof verified on L1),
and **finalized** (challenge window closed on L1, if applicable). The L1 Outbox check is on the
**proven** state: `getProvenCheckpointNumber`. In practice on testnet this is 20–45 minutes after
the L2 tx is mined. The bridge uses the proven checkpoint, not finalization.

---

## Improved loading-bar data model (proposal)

### What Holonym's bars do today

`LoadingStepsBars` counts discrete steps: each segment fills when its `LoadingStep.status` flips to
`'completed'`. `LoadingBar` is a single bar driven by `completedSteps / totalSteps * 100`. Neither
knows real elapsed time or expected remaining time.

### Available data for a time-aware bar

**L1→L2 path** — while polling `getL1ToL2MessageCheckpoint`:
- `pollStartTime: number` — when polling began
- `pollIntervalMs = 30_000` — poll cadence
- `maxWaitMs = 40 * 60 * 1000` — worst-case total
- Each poll returns the checkpoint block number when synced. There is no "block N of M" here because
  the L1→L2 sync depends on the Aztec rollup including the message (timing is block-slot based, not
  proven). Typical latency is 1–4 L2 blocks (≈ 3–12 minutes on testnet).

**L2→L1 path** — while polling `getProvenCheckpointNumber`:
- `provenBlock: number` — current proven checkpoint returned per poll
- `neededBlock: number` — the L2 block that contains the burn tx
- `pollElapsedMs` — elapsed since polling started
- `totalWaitMs = 50 * 60 * 1000` — max poll window

**Concrete data model for a `<ProgressBar>` component:**

```ts
interface BridgeProgressModel {
  /** 0.0–1.0 for the rendered fill width */
  fillFraction: number

  /**
   * Human-readable label.
   * When timeRemainingMinutes is known: "~12 min remaining"
   * When known blocks remain: "3 blocks remaining (~9 min)"
   * Otherwise: the current step label
   */
  label: string

  /** Whether to show an animated indeterminate shimmer (unknown wait). */
  indeterminate: boolean
}
```

**Computation per phase:**

| Phase | fillFraction | label |
|---|---|---|
| L1→L2: awaiting message sync | `elapsedMs / maxWaitMs` capped at 0.95 | `"~${remainingMin} min remaining"` where `remainingMin = (maxWaitMs - elapsedMs) / 60_000` |
| L2→L1: awaiting proven | `(provenBlock - startingProvenBlock) / (neededBlock - startingProvenBlock)` capped at 0.95, OR `elapsedMs / maxWaitMs` before first poll response | `"${neededBlock - provenBlock} blocks remaining (~${Math.round((neededBlock - provenBlock) * BLOCK_PROVE_TIME_SECS / 60)} min)"` |

`startingProvenBlock` is captured at the first poll response. `BLOCK_PROVE_TIME_SECS` is empirically
~60–90 s on testnet (each Aztec block includes up to `EPOCH_DURATION` L2 blocks; epochs prove in
batch). A conservative estimate of 90 s per block gives safe upper-bound estimates.

**What to store per operation in state:**

```ts
interface LiveProofWaitState {
  phase: 'l1_to_l2_sync' | 'l2_proven_wait'
  pollStartedAt: number          // Date.now() when polling began
  maxWaitMs: number
  // L2→L1 only:
  neededBlock?: number
  provenBlockAtStart?: number    // first poll reading
  latestProvenBlock?: number     // updated each poll
}
```

No extra network calls are needed — the data comes from the existing poll loop. The `onPoll` callback
already receives `(provenBlock, neededBlock, elapsedMs)` and can push into this state.

---

## localStorage recovery schema (no-server)

### What Holonym stores server-side (DROP)

- Encrypted `claimSecret` backup (POST `/api/bridge/operations`)
- `operationId` from the server (used for PATCH updates)
- Server-side PATCH of `currentStep`, `status`, `messageHash`, `l2TxHash`, etc.
- Server-side GET for the activity list

All server calls are gated by `operationId`. Unleashed drops every server call and relies solely on
`localStorage`.

### What Holonym stores in localStorage (KEEP)

Keys:
- `bridge:deposits:l1ToL2` — JSON array of L1→L2 deposit operations
- `bridge:withdrawals:l2ToL1` — JSON array of L2→L1 withdrawal operations

**Note on secrets in localStorage:** Holonym stores the `claimSecret` encrypted (AES-GCM with a
deterministic key derived from a wallet signature). Plaintext secrets never appear in localStorage.
Unleashed must replicate this encryption pattern; without a server, the encrypted blob is the only
recovery backstop.

### Minimal localStorage schemas

#### L1→L2 deposit record

```ts
interface DepositRecord {
  // Identity
  id: string               // nanoid — local operation ID
  timestamp: number        // Date.now() at creation

  // Secrets (encrypted — never plaintext)
  encryptedCiphertext: string
  encryptedIv: string
  encryptedTag: string
  keyDerivationDomain: string   // domain string used when deriving the AES key from the sig

  // Bridge parameters (needed to re-execute claim on resume)
  claimSecretHash: string      // hex Fr — safe to store plaintext (commitment only)
  claimAmount: string          // post-fee amount as string (bigint-serialized)
  isPrivacyModeEnabled: boolean
  l1Address: string
  l2Address: string            // Aztec recipient address

  // L1 deposit evidence
  l1TxHash: string | null      // populated after step 4
  l1TxUrl: string | null
  l1BlockNumberBeforeTx: string // L1 block before deposit (recovery block-scan anchor)
  l2BlockNumberBeforeTx: string // L2 block before deposit (info only)

  // Message routing (populated after step 5)
  messageHash: string | null
  messageLeafIndex: string | null  // Inbox leaf index as string

  // Progress
  status: 'pending' | 'deposited' | 'completed' | 'failed'

  // Contract snapshot (required for multi-token recovery)
  portalAddressL1: string
  bridgeAddressL2: string
  tokenAddressL1: string
  tokenAddressL2: string

  // Completion
  l2TxHash: string | null
  l2TxUrl: string | null
  completedAt: number | null
}
```

Fields populated in phases:
- Phase 0 (pre-deposit): all fields except `l1TxHash`, `messageHash`, `messageLeafIndex`, `l2TxHash`
- Phase 1 (after step 4): `l1TxHash`, `l1TxUrl`, `status = 'deposited'`
- Phase 2 (after step 5): `messageHash`, `messageLeafIndex`
- Phase 3 (after claim): `l2TxHash`, `l2TxUrl`, `status = 'completed'`, `completedAt`

#### L2→L1 withdrawal record

```ts
interface WithdrawalRecord {
  // Identity
  id: string
  timestamp: number

  // Secrets (encrypted)
  encryptedCiphertext: string
  encryptedIv: string
  encryptedTag: string
  keyDerivationDomain: string

  // Bridge parameters
  amount: string               // L2 amount (bigint-serialized)
  isPrivacyModeEnabled: boolean
  l1Address: string
  l2Address: string
  l2BridgeAddress: string

  // Baseline anchors
  l1BlockNumberBeforeTx: string
  l2BlockNumberBeforeTx: string | null

  // L2 exit evidence
  l2TxHash: string | null
  l2TxUrl: string | null
  l2BlockNumber: string | null   // L2 block containing the burn tx (needed for witness)

  // L2→L1 Merkle witness (populated after computeL2ToL1MembershipWitness)
  l2ToL1MessageIndex: string | null
  siblingPath: string[] | null

  // Progress
  status: 'pending' | 'submitted' | 'ready' | 'completed' | 'failed'

  // Contract + chain snapshot
  portalAddressL1: string
  bridgeAddressL2: string
  rollupVersion: number
  chainIdL1: number
  l1RollupAddress: string | null

  // Completion
  l1TxHash: string | null
  l1TxUrl: string | null
  completedAt: number | null
}
```

Fields populated in phases:
- Phase 0 (pre-burn): all except `l2TxHash`, `l2BlockNumber`, `l2ToL1MessageIndex`, `siblingPath`
- Phase 1 (after burn): `l2TxHash`, `l2TxUrl`, `l2BlockNumber`, `status = 'submitted'`
- Phase 2 (after witness): `l2ToL1MessageIndex`, `siblingPath`, `status = 'ready'`
- Phase 3 (after L1 withdraw): `l1TxHash`, `l1TxUrl`, `status = 'completed'`, `completedAt`

### Encrypted secret schema (inside the ciphertext)

**L1→L2** — plaintext JSON before encryption:

```json
{
  "claimSecret": "<Fr as hex string>",
  "claimSecretHash": "<Fr as hex string>",
  "amount": "<pre-fee amount string>",
  "l1Address": "0x...",
  "l2Address": "0x...",
  "isPrivacyModeEnabled": false
}
```

**L2→L1** — plaintext JSON before encryption:

```json
{
  "nonce": "<Fr as hex string>",
  "amount": "<L2 amount string>",
  "l1Address": "0x...",
  "l2Address": "0x...",
  "l2BridgeAddress": "0x..."
}
```

Key derivation (from Holonym's pattern): sign a deterministic message with the user's L1 wallet
(`"Sign this message to derive your encryption key for …"`), then derive an AES-GCM key via
`PBKDF2(signature, address, iterations)`. Same wallet → same key → always decryptable.

---

## bridge-core API surface (take/drop)

### Take (framework-agnostic, pure functions)

From [holonym] `bridge-sdk/src/l1.ts`:

| Function | Signature | Notes |
|---|---|---|
| `ensureAllowance` | `({ clients, tokenAddress, owner, spender, amount }) → Promise<void>` | Keep. Standard ERC-20 allowance check + approve. |
| `depositToL2` | `({ clients, portalAddress, tokenAddress, owner, amount, recipient?, isPrivate?, claimSecret? }) → Promise<L1ToL2DepositResult>` | Keep. Generates `claimSecret` if not provided, sends deposit tx, extracts `messageHash` + `messageLeafIndex` from the receipt. |
| `encodeL1Withdrawal` | `({ recipient, amount, l2BlockNumber, messageIndex, siblingPath }) → 0x${string}` | Keep. Pure ABI encoding. Note: Holonym's live `executeL1Withdraw` passes `epoch` not `l2BlockNumber` to the portal in 4.1.x. Rename param or add `epoch` variant. |

From [holonym] `bridge-sdk/src/l2.ts`:

| Function | Signature | Notes |
|---|---|---|
| `claimOnL2` | `({ executor, bridgeAddress, recipient, amount, claimSecret, messageLeafIndex, isPrivate? }) → Promise<L2ClaimResult>` | Keep. Calls `claim_public` / `claim_private` on the L2 bridge. |
| `initiateWithdrawal` | `({ executor, bridgeAddress, tokenAddress, owner, l1Recipient, amount }) → Promise<L2WithdrawalInitiationResult>` | Keep. Issues `burn_public` auth-witness + `exit_to_l1_public`. Returns `l2TxHash`, `l2BlockNumber`, `nonce`. |
| `getL2ToL1Witness` | `({ aztecNodeUrl, l2BlockNumber, l2BridgeAddress }) → Promise<L2ToL1Witness>` | **Drop** — the 4.1.0 API uses `computeL2ToL1MembershipWitness(aztecNode, msgLeaf, txHash)` (from `@aztec/stdlib/messaging`), which takes `txHash` directly and returns `epoch`. Use Holonym's `bridgeL2ToL1.ts:computeWitness` pattern instead. |

From [holonym] `bridge-sdk/src/index.ts` `BridgeSdk` class:

| Method | Take/Drop | Notes |
|---|---|---|
| `depositToL2Public` / `depositToL2Private` | Take (as functions) | Thin wrappers over `depositToL2`. |
| `waitForL1ToL2MessageSync` | **Upgrade** → use `getL1ToL2MessageCheckpoint` pattern from `bridgeL1ToL2.ts:pollL1ToL2MessageSync`. The SDK uses the older `isL1ToL2MessageSynced` API; the frontend uses `getL1ToL2MessageCheckpoint` which returns block info. Prefer the latter for progress data. |
| `claimOnL2Public` / `claimOnL2Private` | Take (as functions) |
| `initiateWithdrawal` | Take (as function) |
| `getL2ToL1Witness` | Drop — see above |
| `finalizeWithdrawal` | Decompose — split into `computeWitness`, `waitForBlockProven`, `executeL1Withdraw` to get the granular polling callbacks the bridge needs. |

From [holonym] `frontend/src/hooks/bridge/bridgeL1ToL2.ts`:

| Function | Take/Drop | Notes |
|---|---|---|
| `pollL1ToL2MessageSync` | **Take** — this is the correct polling pattern using `getL1ToL2MessageCheckpoint`. Expose `onPoll(elapsedMs, maxWaitMs)` callback for the progress bar. |
| `executeL2Claim` | **Take** — includes both normal (known index) and brute-force (index=null) paths. Strip React dependencies (inject `walletAdapter` as a plain function). |
| `getPostFeeClaimAmount` | Take if using fee-bearing portal; drop if the Fee Juice bridge has no protocol fee. |
| `validateAndCaptureBlocks` | Decompose — just call `aztecNode.getBlockNumber()` and `viemPublicClient.getBlockNumber()` inline. |
| `generateAndBackupClaimSecret` | **Decompose** — keep secret generation + hash; drop server backup; keep localStorage write pattern. |
| `checkAndApproveAllowance` | Take — standard Permit2 or plain approve. |
| `sendL1DepositTransaction` | Adapt — drop Permit2/SwapBridgeRouter; call `TokenPortal.depositToAztecPublic` directly (Fee Juice portal is simpler). |
| `waitForReceiptAndExtractEvent` | Take core logic; simplify to standard `TokenPortalAbi` event decode (no custom fee-portal ABI needed for Fee Juice). |
| `persistReceiptToBackend` | **Drop** — no server. |
| `finalizeLocalStorageAfterDeposit` | **Take** — persist deposit record to localStorage. |

From [holonym] `frontend/src/hooks/bridge/bridgeL2ToL1.ts`:

| Function | Take/Drop | Notes |
|---|---|---|
| `computeL2ToL1MessageLeaf` | **Take** — pure computation using `sha256ToField` + `computeL2ToL1MessageHash`. |
| `computeWitness` | **Take** — uses `computeL2ToL1MembershipWitness(aztecNode, msgLeaf, TxHash)` which is the 4.1.0+ API. |
| `waitForBlockProven` | **Take** — polls `getProvenCheckpointNumber`. Expose `onPoll(provenBlock, neededBlock, elapsedMs)` for the progress bar. |
| `executeL1Withdraw` | **Take** — `TokenPortal.withdraw` with `epoch` param. |
| `validateAndCaptureBlocksL2` | Decompose — inline. |
| `encryptAndBackupWithdrawalNonce` | **Decompose** — keep nonce gen + encryption + localStorage write; drop server backup. |
| `executeBurnAndExit` | **Take** — but call via the wallet SDK, not WAAP adapter. |
| `persistBurnReceiptAndPollBlock` | Decompose — keep localStorage write + `getTxReceipt` poll; drop server PATCH. |
| `fetchNodeInfoAndComputeWitness` | Decompose — inline node info fetch + `computeL2ToL1MessageLeaf` + `computeWitness`; drop server PATCH. |

### Drop (server / React-coupled)

| Item | Reason |
|---|---|
| `/api/compute-secret-hash` HTTP call | Drop — call `computeSecretHash` from `@aztec/aztec.js/crypto` directly or in a worker |
| `/api/bridge/operations` POST/PATCH | Drop — no server |
| `patchOperationWithRetry` / `patchOperationAsync` | Drop |
| `logInfo` / `logError` (Datadog) | Drop |
| WAAP wallet (`requestWaapWallet`, `WAAP_METHOD`) | Drop — use the wallet SDK |
| Attestation APIs (POCH, Passport) | Drop — no identity layer in the bridge |
| Permit2 / SwapBridgeRouter paths | Drop — Fee Juice portal is a simpler direct deposit |
| Fuel (FPC/FeeJuice funding via swap) | Drop — Fee Juice bridge itself IS the fuel mechanism |
| React hooks (`useMutation`, `useQuery`) | Replace with Vue composables using `@tanstack/vue-query` or plain `ref`/`watch` state |
| Zustand `bridgeStore` | Replace with Pinia store |
| `BridgeOperationStatus` from Prisma | Replace with local string union type |

---

## Open questions

1. **`computeSecretHash` in browser without SharedArrayBuffer** — Holonym uses a server endpoint to
   avoid the cross-origin isolation requirement. Unleashed must decide: (a) set `Cross-Origin-Opener-Policy:
   same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers (enables SharedArrayBuffer but
   breaks some third-party iframes), or (b) run `computeSecretHash` in a dedicated Web Worker with the
   appropriate headers scoped to the worker, or (c) expose it as a Noir circuit call through the Aztec
   node. Option (a) is the pragmatic default if no embedded iframes are in the bridge UI.

2. **`epoch` vs `l2BlockNumber` in `TokenPortal.withdraw`** — the 4.1.x+ `withdraw` ABI takes `epoch`
   (converted from `l2BlockNumber` via `Rollup.getEpochForCheckpoint(blockNumber)`). Confirm whether
   the Fee Juice portal in the Aztec 4.2.0 monorepo uses the epoch-based signature. If the portal is
   the canonical one from `@aztec/l1-artifacts`, it should; verify by reading the ABI.

3. **Fee Juice bridge `messageLeafIndex` semantics** — the Fee Juice bridge (`FeeJuicePortal`) uses
   the same L1 Inbox mechanism as the ERC-20 portal. Verify that the `DepositToAztecPublic` event
   from `FeeJuicePortal` emits a `key` + `index` field with the same semantics.

4. **Claim amount for Fee Juice** — Holonym's custom portal deducts a protocol fee before hashing the
   message, so the L2 claim uses a post-fee amount. The canonical Aztec `FeeJuicePortal` does not
   apply a protocol fee — the claim amount equals the deposited amount. Confirm by reading the portal
   source.

5. **Activity list without a server** — Holonym's `/activity` page fetches operations from the
   backend. The bridge's equivalent must reconstruct the operation list from localStorage. The schema above
   is sufficient; the activity page just reads and renders the two localStorage arrays.

6. **Recovery when both `messageHash` and `l1TxHash` are missing** — Holonym falls back to scanning
   up to 2000 L1 blocks for portal events. This requires `getLogs` on a public L1 RPC. Unleashed should
   decide whether to support this deep recovery path (useful if the page crashes immediately after the
   L1 tx is sent but before any data is written) or require the user to provide the tx hash manually.
