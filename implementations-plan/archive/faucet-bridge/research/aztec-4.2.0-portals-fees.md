# Aztec 4.2.0 Portals & Fees — Research

Pinned versions: `@aztec/*` 4.2.0, `@defi-wonderland/aztec-standards` 4.2.0-aztecnr-rc.2.

---

## Purpose

Canonical reference for the Aztec 4.2.0 primitives required by the faucet-bridge feature:
- FeeJuicePortal (L1 contract) — interface and L1 call pattern
- FeeJuice claim payment methods (public and private paths)
- SponsoredFPC — the faucet's existing FPC and its coverage
- Inbox/Outbox — timing model and readiness APIs
- `@defi-wonderland/aztec-standards` Token — minter model

---

## FeeJuicePortal

### Address discovery

The portal's L1 address is not hardcoded in any constant file at 4.2.0. It must be fetched dynamically from the node at runtime:

```ts
const { l1ContractAddresses: { feeJuicePortalAddress, feeJuiceAddress, feeAssetHandlerAddress } }
  = await node.getNodeInfo()
```

The `L1ContractAddresses` type (from `@aztec/ethereum/dest/l1_contract_addresses.d.ts`) exposes both:
- `feeJuicePortalAddress: EthAddress` — the FeeJuicePortal L1 contract
- `feeJuiceAddress: EthAddress` — the underlying IERC20 (the "fee asset" / staking asset)
- `feeAssetHandlerAddress?: EthAddress` — optional handler for minting on testnets

The `L1FeeJuicePortalManager.new(node, extendedClient, logger)` static factory wraps this automatically
(`@aztec/aztec.js/dest/ethereum/portal_manager.d.ts`).

**Testnet (Sepolia alpha-testnet, rollupVersion 4127419662):** confirmed addresses are not hardcoded in the SDK.
Use `node.getNodeInfo().l1ContractAddresses` at runtime. The holonym reference script follows the same pattern
([holonym] `bridge-script/index-testnet.ts:426`).

### Underlying fee asset

`FeeJuicePortalAbi` exposes a `UNDERLYING()` view returning `IERC20` — this is the L1-side fee asset ERC20 that
callers must approve before bridging. On testnet this is the token at `feeJuiceAddress` from `getNodeInfo`.

There is also a `ROLLUP()` view and an `INBOX()` view.

### `depositToAztecPublic` signature

Source: `@aztec/l1-artifacts/dest/FeeJuicePortalAbi.d.ts` lines 2200-2224.

```solidity
function depositToAztecPublic(
    bytes32 _to,        // AztecAddress as bytes32
    uint256 _amount,    // amount to bridge (caller must pre-approve UNDERLYING)
    bytes32 _secretHash // hash of the claim secret, computed via computeSecretHash(secret)
) external nonpayable
  returns (
    bytes32,  // messageKey (hash of the inserted L1→L2 message)
    uint256   // messageLeafIndex (index within the L1→L2 message tree)
  )
```

Emits `DepositToAztecPublic(to indexed, amount, secretHash, key, index)`.

The aztec.js helper `L1FeeJuicePortalManager.bridgeTokensPublic(to, amount, mint?)` calls the above, parses the
`DepositToAztecPublic` event, and returns `L2AmountClaim`:

```ts
type L2AmountClaim = {
  claimAmount: bigint
  claimSecret: Fr           // the pre-image
  claimSecretHash: Fr       // sha256-to-field of the pre-image
  messageHash: Hex          // key returned by the portal (= messageKey)
  messageLeafIndex: bigint  // index in the L1→L2 tree
}
```

**There is no `depositToAztecPrivate`** on the FeeJuicePortal at 4.2.0 — fee juice deposits are public-only. This
is by design: fee juice is always claimed into a public balance (via `claim` or `claim_and_end_setup` on the L2
FeeJuice protocol contract), then spent as fees.

### `distributeFees`

```solidity
function distributeFees(address _to, uint256 _amount) external nonpayable
```

Called by the rollup to distribute sequencer fees from the portal back to L1. Not needed for bridge UI.

### Claim secret generation

```ts
import { generateClaimSecret } from '@aztec/aztec.js/ethereum'
// Returns [claimSecret: Fr, claimSecretHash: Fr]
const [secret, secretHash] = await generateClaimSecret()
```

---

## Fee-juice claim payment methods (public + private)

### `FeeJuicePaymentMethodWithClaim`

Source: `@aztec/aztec.js/dest/fee/fee_juice_payment_method_with_claim.d.ts` and `.js`.

```ts
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee'

new FeeJuicePaymentMethodWithClaim(
  sender: AztecAddress,
  claim: Pick<L2AmountClaim, 'claimAmount' | 'claimSecret' | 'messageLeafIndex'>
)
```

Internally calls `FeeJuice.claim_and_end_setup(to, claimAmount, claimSecret, messageLeafIndex)` as a **private**
function on the FeeJuice protocol contract (L2 address 5, `ProtocolContractAddress.FeeJuice`). The claim
consumes the L1→L2 message in the same transaction that it pays the fee — one atomic step.

`getFeePayer()` returns `sender`. `getAsset()` returns `ProtocolContractAddress.FeeJuice`.

**Usage pattern (public fee juice claim):**

```ts
const paymentMethod = new FeeJuicePaymentMethodWithClaim(accountAddress, {
  claimAmount: claim.claimAmount,
  claimSecret: claim.claimSecret,
  messageLeafIndex: claim.messageLeafIndex,
})
// Pass to sendTx fee:
const exec = await interaction.request({ fee: { paymentMethod } })
await wallet.sendTx(exec, { from: account })
```

**Key constraint — gas cap:** The claim is sized at `getCurrentMinFees()` (no padding). Do NOT let the wallet's
default `1.5×` multiplier apply to this payment method — the FPC assertion will fail. In the Nulo wallet this
is handled by `applyEmbeddedFpcGasCap`.

**FeeJuice L2 contract interface** (the target of `claim_and_end_setup`):

```ts
// From @aztec/noir-contracts.js/dest/FeeJuice.d.ts
claim(to, amount, secret, message_leaf_index)           // public, direct claim
claim_and_end_setup(to, amount, secret, message_leaf_index) // private, for fee payment path
balance_of_public(owner)
check_balance(fee_limit)
```

The storage layout has a single `balances` map slot (no `minter` slot — FeeJuice balances are
exclusively funded via L1 portal deposits).

### `PrivateFeePaymentMethod` / `PublicFeePaymentMethod`

Both are present at 4.2.0 but marked `@deprecated` with the note "not supported on mainnet".

```ts
// @deprecated
new PrivateFeePaymentMethod(paymentContract, sender, wallet, gasSettings, setMaxFeeToOne?)
// @deprecated
new PublicFeePaymentMethod(paymentContract, sender, wallet, gasSettings)
```

These call into a custom FPC contract (`paymentContract`) that accepts a non-fee-juice token and internally
handles the swap. They require the FPC contract to expose `pay_fee_with_private_tokens` / `pay_fee_with_tokens`
entry points. No canonical FPC contract supporting these exists in `@aztec/noir-contracts.js` at 4.2.0 — the
only canonical one is `SponsoredFPC`.

**There is no `PrivateMintAndPayFeePaymentMethod` at 4.2.0.** The private fee juice path does not involve
minting — it claims a bridged L1→L2 message. Any "private FPC" use-case at this version must either:
1. Use `SponsoredFeePaymentMethod` (sponsor pays unconditionally), or
2. Use `FeeJuicePaymentMethodWithClaim` (user bridges their own fee juice and claims it in-tx).

---

## FPC (reuse faucet's?)

### SponsoredFPC at 4.2.0

Source: `@aztec/noir-contracts.js/dest/SponsoredFPC.d.ts`.

Methods:
- `sponsor_unconditionally()` — public function called in the setup phase; pays fee juice unconditionally from
  the FPC's own balance
- `public_dispatch(selector)`, `offchain_receive(messages)`, `sync_state(scope)` — internal plumbing

Address computation is deterministic from `SPONSORED_FPC_SALT = BigInt(0)` and the `SponsoredFPCContract.artifact`:

```ts
import { SPONSORED_FPC_SALT } from '@aztec/constants'
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts'
import { SponsoredFPCContract } from '@aztec/noir-contracts.js/SponsoredFPC'
const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
  salt: new Fr(SPONSORED_FPC_SALT), // BigInt(0)
})
// instance.address is the canonical SponsoredFPC address on any Aztec network
```

This is identical to what the faucet already does in
`packages/faucet/src/contracts/sponsored-fpc.ts`.

`SponsoredFeePaymentMethod(fpc.address)` (`@aztec/aztec.js/fee`) wraps this in a payment method object:

```ts
new SponsoredFeePaymentMethod(sponsoredFpcAddress: AztecAddress)
```

### Can SponsoredFPC serve as the bridge FPC?

**For public drips and bridge claims: yes.** The `sponsor_unconditionally()` call has no restriction on what
transaction it sponsors — it pays gas for any tx that includes it in its setup calls. The faucet uses this for
`drip_to_public` and `drip_to_private` already.

**For `FeeJuicePaymentMethodWithClaim`: no additional FPC is needed.** That payment method pays directly from
the claimed fee juice, not from any FPC. They are mutually exclusive paths.

**For a hypothetical "private bridge with private fee payment":** Would need a custom FPC that accepts a
non-fee-juice token and performs an internal swap. No such contract exists canonically at 4.2.0. The bridge UI
should use SponsoredFPC or require the user to have existing fee juice.

**Conclusion:** The faucet's existing SponsoredFPC is sufficient for all public bridge operations. A separate
PRIVATE_FPC is not needed in the 4.2.0 MVP.

---

## Inbox/Outbox + timing APIs

### Inbox (L1→L2)

Source: `@aztec/l1-artifacts/dest/InboxAbi.d.ts`.

Key functions:
- `sendL2Message({ actor: bytes32, version: uint256 }, content: bytes32, secretHash: bytes32) → (bytes32 key, uint256 index)`
  — generic L1→L2 message; **not used directly for fee juice bridging** (the portal wraps it)
- `consume(uint256 _toConsume) → bytes32` — called by the rollup at block build time, not by users
- `getRoot(uint256 checkpointNumber) → bytes32`
- `trees(uint256 checkpointNumber) → { nextIndex: uint256 }`

### L1→L2 message timing (when is an Inbox message consumable on L2?)

The `FEE_ASSET_PORTAL` constant and `Inbox__Ignition` error confirm that messages must wait for their checkpoint
to be built into the L2 chain before they can be consumed.

**Protocol rule:** An L1→L2 message becomes consumable on L2 when:

1. The message is inserted into the current Inbox tree on L1 (happens in the `depositToAztecPublic` tx).
2. The L2 sequencer builds a checkpoint that includes the Inbox root containing that message. The message lands
   in the L2 message tree at the start of the next L2 checkpoint cycle after the L1 tx confirms.
3. The L2 block whose `checkpointNumber >= messageCheckpointNumber` is synced by the node.

**Readiness check (canonical API):**

```ts
// From @aztec/aztec.js/dest/utils/cross_chain.js
async function isL1ToL2MessageReady(node, messageHash: Fr): Promise<boolean> {
  const messageCheckpointNumber = await node.getL1ToL2MessageCheckpoint(messageHash)
  if (messageCheckpointNumber === undefined) return false
  const latestBlock = await node.getBlock('latest')
  return latestBlock !== undefined && latestBlock.checkpointNumber >= messageCheckpointNumber
}

// Blocking wait:
await waitForL1ToL2MessageReady(node, messageHash, { timeoutSeconds: 300 })
```

**Deprecated:** `isL1ToL2MessageSynced` still exists but may return `true` before the message is actually
consumable; do not use it.

**Practical timing on Sepolia alpha-testnet:** The holonym reference polls every 2 minutes for up to 20 minutes
([holonym] `bridge-script/index-testnet.ts:663-700`). No authoritative fixed number of L1/L2 blocks is baked
into the SDK — it depends on sequencer block time and checkpoint cadence.

### Outbox (L2→L1)

Source: `@aztec/l1-artifacts/dest/OutboxAbi.d.ts`.

The `consume` function on the Outbox:
```solidity
function consume(
    DataStructures.L2ToL1Msg memory _message,  // { sender: L2Actor, recipient: L1Actor, content: bytes32 }
    Epoch _epoch,
    uint256 _leafIndex,
    bytes32[] calldata _path                    // sibling path
) external nonpayable
```

`hasMessageBeenConsumedAtEpoch(Epoch, uint256 leafId) → bool` — read-only check.

**L2→L1 timing (when is an Outbox message consumable on L1?):**

1. L2 tx emits an L2→L1 message (in `exit_to_l1_public` or similar).
2. The epoch containing that block must be **proven** — i.e. a proof for the epoch (or a partial proof covering
   that checkpoint) must be submitted to the L1 Rollup contract.
3. The L1 Rollup contract inserts the epoch's out-hash root into the Outbox.
4. The caller can then call `Outbox.consume()` with the membership witness.

**Key: "proven" means an epoch proof, not just a checkpoint.** The rollup's `getProvenCheckpointNumber()` on L1
reports the latest proven checkpoint; an L2→L1 message is consumable when the epoch's proof is settled on L1.

**Readiness check from L1:**

```ts
// Read directly from the Rollup ABI on L1:
const provenCheckpoint = await l1Client.readContract({
  address: rollupAddress,
  abi: RollupAbi,
  functionName: 'getProvenCheckpointNumber',
})
// Block is proven when provenCheckpoint >= blockCheckpointNumber
```

**Membership witness computation (L2 side):**

```ts
import { computeL2ToL1MembershipWitness } from '@aztec/stdlib/messaging'
const witness = await computeL2ToL1MembershipWitness(node, messageHash, txHash)
// witness: { root, leafIndex, siblingPath, epochNumber }
```

The `siblingPath` is the combined path across all 4 tree levels
(message → tx → block → checkpoint → epoch), as documented in
`@aztec/stdlib/dest/messaging/l2_to_l1_membership.d.ts`.

**Practical timing on Sepolia alpha-testnet:** The holonym reference polls every 2 minutes for up to 50 minutes
([holonym] `bridge-script/index-testnet.ts:812-858`). Proving latency on testnet is environment-specific; the
40-60 minute range is a reasonable ballpark but is not a protocol guarantee.

### AztecNode APIs for status polling

From `@aztec/stdlib/dest/interfaces/aztec-node.d.ts`:

| Method | Purpose |
|--------|---------|
| `getBlockNumber()` | Latest L2 block synced by node |
| `getProvenBlockNumber()` | Latest proven L2 block |
| `getCheckpointedBlockNumber()` | Latest checkpointed block |
| `getCheckpointNumber()` | Latest checkpoint number |
| `getL1ToL2MessageCheckpoint(msgHash)` | Checkpoint number when L1→L2 message becomes consumable |
| `isL1ToL2MessageSynced(msgHash)` | @deprecated — do not use |
| `getL2ToL1Messages(epoch)` | All L2→L1 messages in an epoch (for witness computation) |
| `getCurrentMinFees()` | Current minimum fees for gas cap calculations |

---

## aztec-standards Token minter model

Package: `@defi-wonderland/aztec-standards` v4.2.0-aztecnr-rc.2.

Source: `node_modules/@defi-wonderland/aztec-standards/dist/src/artifacts/Token.d.ts`.

### Constructor variants

```ts
// Deploy with a designated single minter (Dripper pattern):
constructor_with_minter(name, symbol, decimals, minter: AztecAddressLike)

// Deploy with an initial public supply (alternative — not used by faucet):
constructor_with_initial_supply(name, symbol, decimals, initial_supply, to)
```

### Mint methods

```ts
mint_to_public(to: AztecAddressLike, amount)   // requires caller == minter
mint_to_private(to: AztecAddressLike, amount)  // requires caller == minter
mint_to_commitment(commitment: FieldLike, amount) // requires caller == minter
```

### Storage layout

```ts
storage: 'name' | 'symbol' | 'decimals' | 'private_balances' | 'total_supply' | 'public_balances' | 'minter'
```

**Single minter slot** — only one address is authorized to mint at a time. There is no `set_minter` in this
interface; the minter is fixed at deployment via `constructor_with_minter`. The faucet deploys the Dripper as
minter (`deployments.json` confirms: `minter` is the Dripper address in each token's `constructorArgs`).

The faucet tokens (USDC at
`0x2af7c3bdd0bee3d825ec40786dc479bfd85f749b45da78a20ddca8ec3e4347c5` and ETH at
`0x060e0d2735b8e7d39fabe8c02b46535b33a7d4e685fa7e31e833b2edfdc26224`) both use `constructor_with_minter` with
the Dripper (`0x172684be7d86acff9c0e16b15e3f34647e5c8c26f0838a0872df7f61ddcb7070`) as minter.

Note: the holonym reference uses `@aztec/noir-contracts.js/Token` (upstream, not `@defi-wonderland`) which has a
`set_minter(address, bool)` pattern instead. These are different contracts.

---

## What is used directly

| Primitive | Where | Notes |
|-----------|-------|-------|
| `SponsoredFeePaymentMethod` + `SponsoredFPCContract` | `packages/faucet/src/composables/useFaucetDrip.ts`, `packages/faucet/src/contracts/sponsored-fpc.ts` | Salt = `BigInt(0)`; address computed deterministically |
| `FeeJuicePaymentMethodWithClaim` | the wallet's fee strategy | The wallet handles the fjwc path; faucet does not use this directly |
| `TokenContractArtifact` + `DripperContractArtifact` | `packages/faucet/src/contracts/deployments.ts` | From `@defi-wonderland/aztec-standards` |
| `isL1ToL2MessageReady` / `waitForL1ToL2MessageReady` | Not yet used — needed by the bridge UI | From `@aztec/aztec.js/messaging` |
| `L1FeeJuicePortalManager` | Not yet used — needed by the bridge UI | From `@aztec/aztec.js/ethereum` |
| `computeL2ToL1MembershipWitness` | Not yet used — needed by the withdraw UI | From `@aztec/stdlib/messaging` |
| `Outbox.consume` (via `L1TokenPortalManager.withdrawFunds`) | Not yet used — needed by the withdraw UI | From `@aztec/aztec.js/ethereum` |

---

## Open questions / unverified

1. **FeeJuicePortal Sepolia address at alpha-testnet rollupVersion 4127419662.** Not extractable from SDK
   constants. Must be read from `node.getNodeInfo().l1ContractAddresses.feeJuicePortalAddress` at runtime.
   The holonym reference confirms this is the correct approach
   ([holonym] `bridge-script/index-testnet.ts:426`). Hardcoding is fragile and not supported.

2. **Outbox proven-epoch latency on Sepolia.** The holonym reference uses a 50-minute max poll window
   ([holonym] `bridge-script/index-testnet.ts:812`). This is empirical, not a protocol guarantee. On testnet,
   the proving cadence is sequencer/prover-dependent and not documented in the SDK constants.

3. **`PrivateFeePaymentMethod` / `PublicFeePaymentMethod` for custom FPCs.** Both are marked `@deprecated`
   at 4.2.0. If a future bridge design requires a custom FPC (e.g. fee-from-bridged-token), these would need
   a non-canonical FPC contract. Not needed for MVP.

4. **`SPONSORED_FPC_SALT = BigInt(0)`.** Confirmed as `export const SPONSORED_FPC_SALT = BigInt(0)` in
   `@aztec/constants/dest/constants.js`. The faucet already relies on this correctly. Worth confirming stays
   stable if `@aztec/*` is ever bumped.

5. **Inbox `consume` is internal.** The `consume(uint256 _toConsume)` on the Inbox is called by the rollup at
   checkpoint build time, not by application code. Application code never calls it directly.

6. **aztec-standards Token has no `set_minter`.** The minter is fixed at deployment. A bridge design that wants
   to grant minting to multiple contracts (e.g. both a Dripper and a bridge contract) would need to deploy with
   the Dripper as minter, then have the Dripper delegate — or deploy the token with the bridge as minter and
   give the Dripper an authwit. This is a deployment-time concern for the bridge token design.
