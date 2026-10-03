# Wonderland aztec-fee-payment — Research Notes

**Aztec version**: 4.2.0-aztecnr-rc.2  
**Library version**: `@wonderland/aztec-fee-payment@4.2.0-aztecnr-rc.2`  
**Source**: [wonderland-fee] `aztec-fee-payment` (external repo)  
**Status**: This library is live, published, and already consumed by Holonym.

---

## Purpose

A fully private Fee Payment Contract (FPC) for Aztec. Enables users who bridge
FeeJuice (FJ) from L1 to the FPC's address to acquire private internal FJ
balance and then sponsor their own L2 transactions — with **no owner, no
agent, no public functions**. Auth is purely cryptographic: the bridge secret
binds the claimer's Aztec address, so only the user who did the L1 deposit can
claim the credit.

Two usage flows exist:

| Flow | When to use |
|------|-------------|
| Two-step: `mint` then `FPCFeePaymentMethod` | User pre-funds balance; later txs use `pay_fee`. |
| Cold-start: `PrivateMintAndPayFeePaymentMethod` | Claim + mint + pay fee in one tx, no prior balance. |

---

## PrivateFPC contract (functions, auth, secret derivation)

Source: [wonderland-fee] `src/nr/private_contract/src/main.nr`

### Storage

```rust
balances: Owned<BalanceSet<Context>, Context>
```

No owner field. No `DelayedPublicMutable`. Balance is a private note-based
mapping: `account → internal FJ balance`.

### Functions

#### `pay_fee()` — `#[external("private")] #[allow_phase_change]`

Deducts `max_gas_cost` from `msg_sender`'s internal balance via recursive
`try_sub`. Calls `set_as_fee_payer()` then `end_setup()`. No refund: the full
max gas cost is consumed.

#### `mint(amount: u128, salt: Field, leaf_index: Field)` — `#[external("private")]`

Proves a prior `FeeJuice.claim` entirely in private and credits `amount` to
`msg_sender`. Steps:
1. `claimer = msg_sender()`
2. Reconstruct `feejuice_nullifier` via `compute_feejuice_claim_nullifier`.
3. `assert_nullifier_exists(compute_nullifier_existence_request(feejuice_nullifier, FEE_JUICE_ADDRESS))`
4. `push_nullifier(feejuice_nullifier)` — FPC-scoped double-spend guard.
5. `balances.at(claimer).add(amount).deliver(ONCHAIN_UNCONSTRAINED)`.

#### `mint_and_pay_fee(amount: u128, salt: Field, leaf_index: Field)` — `#[external("private")] #[allow_phase_change]`

Cold-start flow. Same bridge-claim proof as `mint`, but:
- Asserts `amount >= max_gas_cost`.
- Credits `amount - max_gas_cost` to claimer (fee implicitly deducted).
- Calls `set_as_fee_payer()` + `end_setup()`.

Enables bridge + fee sponsorship in **a single transaction** without any prior
internal balance.

#### `balance_of(account: AztecAddress)` — `#[external("utility")] unconstrained`

View. Returns internal FJ balance of an account.

#### Internal helpers

- `_deduct_max_gas_cost` — computes max gas cost, calls `_subtract_balance`,
  returns change note.
- `_subtract_balance` — `try_sub` up to `INITIAL_TRANSFER_CALL_MAX_NOTES=2`;
  recurses via `recurse_subtract_balance_internal` (max 8 notes) if
  insufficient.
- `recurse_subtract_balance_internal` — `#[only_self]` recursive entry.

### Auth model

**No owner. No agent. Pure cryptographic binding.**

The bridge secret is derived from `(salt, claimer_address)`. Only the wallet
whose address was used as `claimer` during the L1 deposit can reconstruct the
correct FeeJuice nullifier. The kernel circuit verifies the nullifier existence
read request privately — no public function call needed.

### Secret derivation (exact formula)

```
secret = poseidon2_hash_with_separator(
    [salt, claimer.to_field()],
    DOM_SEP__FPC_BRIDGE_SECRET   // = 3952304070 = 0xEB935FC6
)
```

Domain separator `3952304070` is `poseidon2_hash_bytes("az_dom_sep__fpc_bridge_secret") & 0xFFFFFFFF`.

This matches what Holonym's `/api/compute-secret-hash` route computes:

```ts
const secret = await poseidon2HashWithSeparator(
    [saltFr, claimerFr],
    3952304070,
)
```

**Critical**: `claimer = msg_sender()` in both `mint` and `mint_and_pay_fee`.
The user's Aztec address must be passed as `claimer` when deriving the secret
on the TS side. If wrong, the reconstructed FeeJuice nullifier won't match.

### Nullifier reconstruction (verified against source)

```
secret      = derive_bridge_secret(salt, claimer)
secretHash  = compute_secret_hash(secret)
contentHash = sha256(keccak256("claim(bytes32,uint256)")[0:4] || fpc_address_bytes32 || amount_bytes32)
messageHash = sha256(feeJuicePortalEthAddr || chainId || FEE_JUICE_L2_ADDR || version || contentHash || secretHash || leafIndex)
nullifier   = poseidon2([messageHash, secret], DOM_SEP__MESSAGE_NULLIFIER)
```

Protocol invariant: `feeJuicePortalEthAddr = EthAddress::from_field(FEE_JUICE_ADDRESS.to_field())`.

The FPC-scoped nullifier (double-spend guard) is the same raw `feejuice_nullifier`
value but siloed under the FPC address by the kernel: `poseidon2([FPC_addr, feejuice_nullifier])`.
The FeeJuice-siloed version is `poseidon2([FEE_JUICE_ADDRESS, feejuice_nullifier])`.
Second `mint` call with same deposit: FPC-scoped nullifier already exists → reverts.

### Shared library dependency

`get_max_gas_cost` is imported from `fpc_lib` ([wonderland-fee] `src/nr/fpc_lib/src/lib.nr`):

```rust
max_fee_per_da_gas * (da_gas_limit as u128) + max_fee_per_l2_gas * (l2_gas_limit as u128)
```

Teardown gas is NOT double-counted (kernel already includes teardown in
`gas_limits`). `max_priority_fees_per_gas` also excluded (EIP-1559 semantics).

---

## fee-payment-methods TS (classes + signatures)

Source: [wonderland-fee] `src/ts/fee-payment-methods/`

### `FPCFeePaymentMethod` — `shared.ts`

```ts
class FPCFeePaymentMethod implements FeePaymentMethod {
    constructor(private readonly fpcAddress: AztecAddress) {}
}
```

Generic. Works with any FPC that implements `pay_fee()`. Suitable for the
two-step flow after internal balance is funded. Emits a single private call:
`pay_fee()` on the FPC.

### `PrivateMintAndPayFeePaymentMethod` — `private.ts`

```ts
class PrivateMintAndPayFeePaymentMethod implements FeePaymentMethod {
    constructor(
        private readonly fpcAddress: AztecAddress,
        private readonly amount: bigint,
        private readonly secret: Fr,
        private readonly salt: Fr,
        private readonly leafIndex: Fr,
    ) {}
}
```

Cold-start method. `getExecutionPayload()` emits two calls in the setup phase:

1. `FeeJuice.claim(fpcAddress, amount, secret, leafIndex)` — private
2. `PrivateFPC.mint_and_pay_fee(amount, salt, leafIndex)` — private

The FeeJuice nullifier emitted by call 1 is pending (same tx) when call 2
asserts its existence — `compute_nullifier_existence_request` handles both
pending and settled nullifiers.

### Gas utilities — `utils/gas.ts`

Key exports:

| Export | Use |
|--------|-----|
| `estimateGasSettings(interaction, opts)` | Simulate with `includeMetadata:true`; derive tight gas limits + fee caps. Preferred over static limits. |
| `maxFeesPerGasFromBaseFees(baseFees, multiplier?)` | Multiplies node base fees by `6/5` (ceiling) to get `maxFeesPerGas`. |
| `maxGasCostFor(maxFeesPerGas, gasLimits)` | Computes worst-case cost for amount sufficiency checks. |
| `REASONABLE_GAS_LIMITS` | Default `Gas` with `DEFAULT_DA_GAS_LIMIT` + `DEFAULT_L2_GAS_LIMIT`. |
| `DEFAULT_FEE_MULTIPLIER` | `{ numerator: 6n, denominator: 5n }` (exact 1.2×, no float). |

`estimateGasSettings` queries `aztecNode.getCurrentMinFees()`, applies the
multiplier, sets `maxPriorityFeesPerGas = maxFeesPerGas`, then simulates the
interaction and returns a `GasSettings` built from the simulated gas usage.

---

## Deploy + fuelRecipient address

Source: [wonderland-fee] `src/ts/utils/deploy.ts`, `scripts/compute.ts`

### PrivateFPC has no constructor, no deployment transaction needed

The contract is fully private (zero public functions). Its class does not need
to be registered in the class registry. The address is computed deterministically
from `(artifactClassHash, salt)` with `deployer = AztecAddress.ZERO`
(universal deploy — deployer address not mixed in).

```ts
async function registerPrivateContract(wallet: Wallet, salt: Fr): Promise<PrivateFPCContract> {
    return PrivateFPCContract.deploy(wallet).register({
        contractAddressSalt: salt,
        skipInitialization: true,
        deployer: AztecAddress.ZERO,
    });
}
```

No on-chain tx, just a local PXE registration.

### Address computation

```
yarn compute   # requires PRIVATE_FPC_SALT in .env
```

Uses `getContractInstanceFromInstantiationParams(PrivateFPCContractArtifact, { constructorArgs:[], salt, publicKeys: PublicKeys.default(), deployer: AztecAddress.ZERO })`.

**DANGER**: address is derived from compiled bytecode. Different Aztec version
→ different bytecode → different address. Bridging FJ to the wrong address is
**unrecoverable**.

### fuelRecipient on L1

For private fuel, the L1 `FeeJuicePortal.depositToAztecPublic` call must use:

```solidity
_to = PrivateFPC.address    // NOT the user's Aztec address
```

The FPC's public FeeJuice balance is credited when FeeJuice.claim is called on
L2. That public balance is what the sequencer draws from when the FPC sets
itself as fee payer.

To separately fund the FPC's *public* FeeJuice balance (for sequencer payment),
a second `depositToAztecPublic(_to=FPC, ...)` + `FeeJuice.claim` is needed — but
this uses a standard random secret, not the claimer-bound one. The internal
balance and the public balance are separate: internal balance is for `pay_fee()`
debits, public balance is what the sequencer actually receives.

---

## Integration (npm dep? Nargo git dep? vendor?)

### Published package name

The npm package is published as **`@wonderland/aztec-fee-payment`** (not
`@defi-wonderland/aztec-fee-payment` — the root `package.json` has a private
workspace name but the `build-package.sh` renames it to `@wonderland/...` in
the export directory before publishing). Holonym confirms this:

```json
"@wonderland/aztec-fee-payment": "4.2.0-aztecnr-rc.2"
```

### TS dependency (for payment method classes + utilities)

```jsonc
// bun equivalent
"@wonderland/aztec-fee-payment": "4.2.0-aztecnr-rc.2"
```

Import paths:
- `@wonderland/aztec-fee-payment` — main: `PrivateFPCContract`, both payment method classes, gas utils, `registerPrivateContract`
- `@wonderland/aztec-fee-payment/artifacts/private` — artifact only
- `@wonderland/aztec-fee-payment/fee-payment-methods` — payment methods only
- `@wonderland/aztec-fee-payment/utils` — gas/deploy utils only

The package ships `dist/` (compiled JS+types) and `target/` (compiled Noir
artifacts). No build step needed by consumers.

### Nargo dependency (for the PrivateFPC Noir contract, if needed)

If the bridge's Noir contracts need to import `PrivateFPC` or `fpc_lib` types:

```toml
# Nargo.toml [dependencies]
private_contract = { git = "https://github.com/defi-wonderland/aztec-fee-payment", tag = "<commit/tag>", directory = "src/nr/private_contract" }
fpc_lib = { git = "https://github.com/defi-wonderland/aztec-fee-payment", tag = "<commit/tag>", directory = "src/nr/fpc_lib" }
```

The library's own `Nargo.toml` pins dependencies:
```toml
aztec = { git = "https://github.com/AztecProtocol/aztec-packages/", tag = "v4.2.0-aztecnr-rc.2", ... }
balance_set = { same tag }
keccak256 = { tag = "v0.1.3", git = "https://github.com/noir-lang/keccak256" }
```

**Version constraints**: must match Aztec 4.2.0-aztecnr-rc.2. `keccak256 v0.1.3`
is pinned inside the contract's `Nargo.toml` — any consumer Nargo workspace
that also uses keccak256 must agree on this version.

### Integration recommendation

The faucet+bridge does not need to write its own PrivateFPC Noir contract —
it only needs to:

1. **TS dependency** (npm): `@wonderland/aztec-fee-payment@4.2.0-aztecnr-rc.2`
2. **Register the contract** in the user's PXE using `registerPrivateContract(wallet, PRIVATE_FPC_SALT_FR)`.
3. **Compute the deterministic address** once with `yarn compute` (or equivalent)
   using `getContractInstanceFromInstantiationParams`, then persist it as a
   deployment constant.
4. **No Nargo dep** unless the bridge's own Noir contracts call into PrivateFPC.
5. **No vendor**: the package is published and versioned; use npm directly.

**Peer constraint**: `@aztec/*` packages must all be at `4.2.0-aztecnr-rc.2`.
`@noble/hashes` should be pinned to `1.8.0` (Wonderland's `resolutions`
guard). Bun's 7-day minimum release age may need an exclude for this package's
version on initial install (check date of publish vs gate).

---

## End-to-end private fuel flow (verified)

Verified against: [wonderland-fee] `src/nr/private_contract/src/main.nr`,
[wonderland-fee] `src/ts/fee-payment-methods/private.ts`,
[wonderland-fee] `src/ts/test/harness.ts`,
[holonym] `frontend/src/hooks/bridge/bridgeL1ToL2.ts:750-800`,
[holonym] `frontend/src/hooks/useL1Operations.ts:892-921`

### Step-by-step

```
1. Off-chain prep
   salt = Fr.random()
   secret = poseidon2HashWithSeparator([salt, userAztecAddress], 3952304070)
   secretHash = computeSecretHash(secret)

2. L1: FeeJuicePortal.depositToAztecPublic(
       _to        = PrivateFPC.address,
       _amount    = fuelAmount,
       _secretHash = secretHash
   )
   → L1→L2 message: { recipient: FeeJuice, content: sha256("claim(bytes32,uint256)" selector || FPC || amount), secretHash }
   → event emits leafIndex (message leaf index in the L1→L2 message tree)

3. L2 message sync: poll isL1ToL2MessageReady until true.

4. L2 tx: user submits a transaction whose fee is paid via PrivateMintAndPayFeePaymentMethod
   Setup phase calls (in order):
     a. FeeJuice.claim(fpcAddress, amount, secret, leafIndex)
        → consumes L1→L2 message; emits FeeJuice nullifier (siloed under FEE_JUICE_ADDRESS)
        → credits FPC's public FeeJuice balance by `amount`
     b. PrivateFPC.mint_and_pay_fee(amount, salt, leafIndex)
        → msg_sender = user
        → reconstructs FeeJuice nullifier using (fpcAddress, amount, salt, msg_sender, leafIndex, chainId, version)
        → assert_nullifier_exists: kernel verifies the pending nullifier from step a
        → push_nullifier(feejuice_nullifier): FPC-scoped double-spend guard
        → credits (amount - max_gas_cost) to user as private FJ note
        → set_as_fee_payer() + end_setup()
   App logic phase: user's actual tx (token transfer, bridge claim, etc.)
   
5. Sequencer: executes the tx; draws from FPC's public FeeJuice balance for protocol fee.
```

**Notes on step 4**: `FeeJuice.claim` increases the FPC's **public** FJ balance
(visible on-chain). `mint_and_pay_fee` credits the user's **private internal** FJ
note in the FPC's `balances` storage (not the same thing). The fee is paid from
the public balance. The internal balance is for future `pay_fee()` calls.

### Alternative two-step flow

If the user has already done the bridge and wants to pre-fund their internal
balance before sending txs:

```
L2 tx A: FeeJuice.claim(fpcAddress, amount, secret, leafIndex)
L2 tx B: fpc.mint(amount, salt, leafIndex)    [internally funds user's balance]
L2 tx C: myContract.doSomething()             [fee: FPCFeePaymentMethod]
```

Steps A and B can be batched in the same tx via `BatchCall`.

---

## How Holonym consumed it

Source: [holonym] `frontend/src/utils/walletAdapters.ts:112-120`,
[holonym] `frontend/src/hooks/useL1Operations.ts:892-921`,
[holonym] `frontend/src/app/api/compute-secret-hash/route.ts`,
[holonym] `frontend/src/utils/walletCapabilities.ts`

### Registration

On wallet connection, Holonym calls `registerPrivateContract(this.wallet, Fr.ZERO)` —
using `salt = Fr.ZERO` (zero salt). The FPC address is read from an env/config
var `PRIVATE_FPC_ADDRESS` and stored in deployment config.

```ts
const { registerPrivateContract } = await import('@wonderland/aztec-fee-payment')
await registerPrivateContract(this.wallet, Fr.ZERO)
```

### Secret derivation

Holonym uses a Next.js server route (`/api/compute-secret-hash`) to compute the
poseidon2 hash server-side, avoiding `SharedArrayBuffer` requirements in the browser:

```ts
// POST /api/compute-secret-hash with { type: 'fpc-bridge', salt, claimer }
// Server returns { secret, secretHash }
// DOM_SEP_FPC_BRIDGE_SECRET = 3952304070
```

`claimer` = user's Aztec address string. `salt` = random `Fr`.

### L1 deposit

Holonym uses `SwapBridgeRouter.bridgeWithFuel()` (a custom L1 contract that
bundles token bridge + fee juice swap in one tx). The relevant params:

```ts
fuelRecipient: privateFuel.fpcAddress,   // PrivateFPC address (NOT user)
fuelSecretHash: privateFuelSecretHash,    // computeSecretHash(poseidon2([salt, userAddr], DOM_SEP))
```

For the bridge, which uses `FeeJuicePortal.depositToAztecPublic` directly (no swap
router), the equivalent is just:

```solidity
FeeJuicePortal.depositToAztecPublic(
    _to=privateFpcAddress, _amount=fuelAmount, _secretHash=fuelSecretHash
)
```

### L2 claim + fee payment

After message sync, Holonym constructs `PrivateMintAndPayFeePaymentMethod` and
passes it as the `feeOption` for the token bridge claim transaction:

```ts
const { PrivateMintAndPayFeePaymentMethod, REASONABLE_GAS_LIMITS,
        maxFeesPerGasFromBaseFees, maxGasCostFor } =
    await import('@wonderland/aztec-fee-payment')

const paymentMethod = new PrivateMintAndPayFeePaymentMethod(
    AztecAddress.fromString(privateFuel.fpcAddress),
    receipt.fuelAmount,        // bigint
    backup.privateFuelSecret,  // Fr (derived by server)
    backup.privateFuelSalt,    // Fr (random per deposit)
    new FieldFr(BigInt(receipt.fuelMessageLeafIndexStr!)),  // Fr
)

// gas settings built manually (no estimateGasSettings here — cold start)
const baseFees = await aztecNode.getCurrentMinFees()
const maxFeesPerGas = maxFeesPerGasFromBaseFees(baseFees)
const gasLimits = REASONABLE_GAS_LIMITS
```

Note: Holonym passes `GasFees.empty()` as `maxPriorityFeesPerGas` rather than
mirroring `maxFeesPerGas`. Wonderland's own SDK (`estimateGasSettings`) sets
them equal per PRD 1.4. Unleashed should prefer `estimateGasSettings` for correctness.

### Capability manifest

Holonym declares `mint`, `mint_and_pay_fee`, `pay_fee` as `transactionScope`
and `balance_of` as `simulationUtilities` for the FPC address in its wallet
capability manifest. The app's manifest should do the same.

---

## Open questions

1. **Salt value**: Holonym uses `Fr.ZERO` as the FPC salt (fixed). This is
   fine for a single-network deployment where one FPC address is canonical. Unleashed
   should decide whether to use `Fr.ZERO` or a meaningful salt, then compute
   and lock the address before any mainnet usage.

2. **FPC public FeeJuice balance seeding**: The FPC's *public* balance must be
   funded before it can pay sequencers. This is separate from users' internal
   balances. For a faucet/bridge dApp, either (a) the operator seeds the FPC at
   deploy time, or (b) each user's `FeeJuice.claim` naturally credits the FPC.
   Option (b) is how the private flow works — each claimer's `FeeJuice.claim`
   increments the FPC's public balance, so the FPC self-funds from user deposits.
   The operator still needs an initial seed for the first users before any
   private-fuel deposits have been claimed.

3. **Cold-start tx: who provides the initial fee for the L2 claim?** In
   Holonym's flow, the user's L2 claim tx (bridge token claim) uses
   `PrivateMintAndPayFeePaymentMethod` as its fee option — so the FPC pays for
   that tx from the private fuel deposit. This means no prior FJ is needed by
   the user for their first tx. The faucet can follow the same pattern.

4. **`poseidon2HashWithSeparator` availability in browser**: The hash requires
   `SharedArrayBuffer` / cross-origin isolation when running in WASM. Holonym
   works around this by proxying through a server route. The app could do the same
   or check whether `@aztec/foundation/crypto/sync` exports a sync version (it
   does: `poseidon2HashWithSeparator` from `@aztec/foundation/crypto/sync`).

5. **Versioned address**: If Aztec is bumped from 4.2.0-aztecnr-rc.2, the FPC
   contract bytecode changes, the address changes, and any deposited FJ to the
   old address is stranded. This is a critical operational risk. The address
   must be re-computed and re-verified on every Aztec version bump before
   publishing an update.

6. **`fuelAmount` vs `claimAmount` precision**: The `fuelAmount` in
   `PrivateMintAndPayFeePaymentMethod` must exactly match the bridged amount,
   since `compute_feejuice_claim_nullifier` hashes it. A mismatch (e.g. due to
   portal fees) produces a wrong nullifier → `assert_nullifier_exists` fails.
   Use `receipt.fuelAmount` extracted from the `DepositToAztecPublic` event
   (post-fee amount), not the input amount.

7. **`bun audit` / min-release-age**: `@wonderland/aztec-fee-payment` and the
   `@aztec/*` packages are pinned exactly and should be in `minimumReleaseAgeExcludes`
   if their publish date is recent. Verify before adding to a new project.
