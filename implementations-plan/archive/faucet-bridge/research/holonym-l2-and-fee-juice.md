# Holonym L2 (Noir/Aztec) + Fee Juice claim pipeline + L1→L2 content-hashes

Research for the faucet+bridge plan. Highest-priority module: the private-Fee-Juice /
content-hash nuance the author spent significant time fixing.

Aztec pinned at `4.2.0` (noir tag `v4.2.0-aztecnr-rc.2`). Token contract from defi-wonderland
aztec-standards `prerelease-1ad0e28`. **Do NOT propose version changes.**

Path convention: `[holonym] <repo-relative>` for the reference repo; bare repo-relative for this repository;
`[nargo-cache] <path>` for read-only dependency sources pulled from the local nargo cache (these are
the exact pinned upstream sources, shown to quote canonical signatures verbatim).

---

## Purpose

Document precisely, with exact signatures and arg order, how Holonym's bridge moves a fungible
token L1→L2 and how it funds the user's L2 gas ("fuel") via the canonical Fee Juice portal, so Unleashed
can copy the mechanism faithfully while **dropping** the identity/attestation layer (clean-hands +
passport) and the Uniswap swap-to-fuel periphery.

Two independent L1→L2 messages are produced per fueled deposit:
1. **Token message** — consumed by the L2 `TokenBridge.claim_public/claim_private`, mints the bridged token.
2. **Fee Juice message** — consumed by the canonical `FeeJuice.claim`/`claim_and_end_setup`, credits gas.

These are completely separate flows with separate secrets, separate content hashes, separate portals.
The token side is canonical-with-attestation; the fuel side is **100% canonical** (no Holonym code at all
on L2 — it's Aztec's protocol FeeJuice contract).

---

## Key files

**L2 Noir contracts (Holonym):**
- `[holonym] aztec-contracts/token_bridge/src/main.nr` — the bridge (claim_public/private, exit_to_l1, attestation gates).
- `[holonym] aztec-contracts/token_bridge/src/config.nr` — `Config { token_minter_proxy, portal }`.
- `[holonym] aztec-contracts/token_minter_proxy/src/main.nr` — the shared-minter proxy (THE multi-minter mechanism).
- `[holonym] aztec-contracts/token_bridge/src/test/{token_bridge_tests,utils,mod}.nr` — tests (attestation only; claim paths skipped — see below).
- `[holonym] aztec-contracts/*/Nargo.toml` — dependency pins.

**L1 Solidity (Holonym):**
- `[holonym] l1-contracts/src/TokenPortal.sol` — custom portal: canonical content-hash + fee + attestation gate.
- `[holonym] l1-contracts/src/SwapBridgeRouter.sol` — Permit2 periphery; the ONLY place `feeJuicePortal.depositToAztecPublic` is called.
- `[holonym] l1-contracts/src/UniswapFuelSwap.sol` — swaps ERC20→FeeJuice on L1 (DROP).

**Fee-juice pipeline (frontend / SDK):**
- `[holonym] frontend/src/hooks/useL1Operations.ts` ~600-963 — public/private fuel branch, payment-method construction.
- `[holonym] frontend/src/hooks/bridge/bridgeL1ToL2.ts` — deposit steps, secret derivation, claim execution.
- `[holonym] frontend/src/app/api/compute-secret-hash/route.ts` — server-side poseidon2 hashing incl. the `fpc-bridge` derivation.
- `[holonym] bridge-script/fees.ts` — **cleanest end-to-end Fee Juice reference** (no swap, no attestation). Best starting point.
- `[holonym] bridge-sdk/src/{l1,l2}.ts` — clean deposit/claim helpers, also good reference.

**Canonical upstream sources (pinned, read-only from nargo cache):**
- `[nargo-cache] .../v4.2.0-aztecnr-rc.2/noir-projects/noir-contracts/contracts/libs/token_portal_content_hash_lib/src/lib.nr` — the content-hash functions both sides use.
- `[nargo-cache] .../v4.2.0-aztecnr-rc.2/noir-projects/noir-contracts/contracts/protocol/fee_juice_contract/src/main.nr` — canonical FeeJuice (`claim`, `claim_and_end_setup`, `claim_helper`).
- `[nargo-cache] github.com/defi-wonderland/aztec-standards/prerelease-1ad0e28/src/token_contract/src/main.nr` — the L2 token (single-`minter` model).

**`@aztec/aztec.js@4.2.0` fee payment method (public fuel):**
- `dest/fee/fee_juice_payment_method_with_claim.{d.ts,js}` — `FeeJuicePaymentMethodWithClaim`.

**`@wonderland/aztec-fee-payment` (private fuel, version `4.2.0-aztecnr-rc.2`):**
- `dist/src/ts/fee-payment-methods/private.{d.ts,js}` — `PrivateMintAndPayFeePaymentMethod`.
- `dist/src/artifacts/PrivateFPC.*` — the PrivateFPC contract artifact (Noir source NOT shipped; behavior documented via TSDoc + the compute-secret-hash route + git history).

> NOTE ON PACKAGE NAMING: current code imports from `@wonderland/aztec-fee-payment` and the class is
> `PrivateMintAndPayFeePaymentMethod`. The git history (commit `b21421a`, the fix commit) used the older
> names `@defi-wonderland/aztec-fee-payment` / `BridgedMintAndPayFeePaymentMethod`. Same package, renamed.
> The `index.d.ts` example block still says `@defi-wonderland/...`; the actual install path is `@wonderland/...`.

---

## THE PRIVATE FEE JUICE NUANCE (lead with this — exhaustive)

### Author's claim, verified

> "the private fee juice sends the fee juice to the public fee juice but claims himself."

**CONFIRMED, with one precision.** The phrase decomposes into two facts:

1. **"sends the fee juice to the public fee juice"** — On L1, Fee Juice is ALWAYS bridged through the
   single canonical entry `FeeJuicePortal.depositToAztecPublic(to, amount, secretHash)`. There is no
   "private" Fee Juice portal entry. The deposit lands as Fee Juice in the recipient's **public**
   balance on L2 (FeeJuice only has `balance_of_public`; there is no private FJ note). Privacy of the
   *fuel* is achieved entirely on the L2 side by routing through an FPC, not by a different L1 deposit.

2. **"but claims himself"** — The L1→L2 Fee Juice message is bound only to `(to, amount)` (see
   `claim_helper` below). The claim secret is NOT bound to the tx submitter. So whoever submits the L2
   `claim` tx can be anyone; the FJ credits the `to` address baked into the content hash. In the
   public path, `to == user` and the user submits → user gets FJ → user pays own gas → "claims
   himself." In the private path, `to == FPC`, and the user submits the claim (msg_sender = user)
   inside the same tx that calls the FPC's `mint_and_pay_fee` — so the FPC ends up funded and the FPC
   pays the sequencer, while the user is credited the remainder privately.

### Q: Does the L1 fee-juice deposit ALWAYS go through `FeeJuicePortal.depositToAztecPublic`, regardless of public vs private?

**YES.** Single L1 call site, both modes:

```solidity
// [holonym] l1-contracts/src/SwapBridgeRouter.sol:265-269  (inside bridgeWithFuel)
(fuelKey, fuelIndex) = feeJuicePortal.depositToAztecPublic(
    p.fuelRecipient,   // <-- the ONLY thing that differs public vs private
    fuelReceived,
    p.fuelSecretHash
);
```

`IFeeJuicePortal` is the canonical Aztec interface (`import {IFeeJuicePortal} from "@aztec/core/interfaces/IFeeJuicePortal.sol"`,
SwapBridgeRouter.sol:8). `depositToAztecPublic` is its only deposit method. There is no
`depositToAztecPrivate` on the Fee Juice portal — that name exists only on Holonym's *Token* portal.

Confirmed independently in the clean reference script: `[holonym] bridge-script/fees.ts` uses
`L1FeeJuicePortalManager.bridgeTokensPublic(recipient, amount, true)` for BOTH the user-funding case
(line 72, recipient = user) and the FPC-funding case (line 104, recipient = fpc.address). Same method.

### Q: What is `fuelRecipient` set to for PUBLIC vs PRIVATE?

| Mode | `fuelRecipient` (L1) | Source |
|---|---|---|
| **Public fuel** | the **user's L2 Aztec address** | `[holonym] frontend/src/hooks/bridge/bridgeL1ToL2.ts:1004,1040` — `(privateFuel ? privateFuel.fpcAddress : (fuel ? aztecAddress : zeroBytes32))` |
| **Private fuel** | the **PrivateFPC address** (`PRIVATE_FPC_ADDRESS`) | same line; `privateFuel.fpcAddress` is set from `PRIVATE_FPC_ADDRESS` at `useL1Operations.ts:635` |

The struct field is explicitly commented:
```solidity
// [holonym] l1-contracts/src/SwapBridgeRouter.sol:126
bytes32 fuelRecipient; // L2 address that receives FeeJuice (user for public fuel, FPC for private fuel)
```

### Q: How does the user/FPC "claim himself"? Trace the payment methods.

**Canonical FeeJuice content hash (what the L1 message commits to):**
```noir
// [nargo-cache] fee_juice_contract/src/main.nr:48-60  (claim_helper)
let content_hash: Field = get_bridge_gas_msg_hash(to, amount);   // bound to (to, amount) ONLY
context.consume_l1_to_l2_message(content_hash, secret, portal_address, message_leaf_index);
// ...then enqueues _increase_public_balance(to, amount)
```
The secret is a free input; the recipient `to` is fixed in the hash. This is the structural reason
the claim is permissionless-by-submitter but recipient-locked.

**PUBLIC fuel — `FeeJuicePaymentMethodWithClaim` (from `@aztec/aztec.js/fee`):**
```ts
// constructor signature — dest/fee/fee_juice_payment_method_with_claim.d.ts:13
constructor(sender: AztecAddress, claim: Pick<L2AmountClaim, 'claimAmount'|'claimSecret'|'messageLeafIndex'>)

// [holonym] frontend/src/hooks/useL1Operations.ts:928-933
const paymentMethod = new FeeJuicePaymentMethodWithClaim(
  AztecAddress.fromString(aztecAddress),          // sender == user (== fuelRecipient on L1)
  {
    claimAmount: receipt.fuelAmount,              // POST-FEE FJ amount from the L1 event
    claimSecret: backup.fuelSecret,               // a RANDOM secret (public path)
    messageLeafIndex: BigInt(receipt.fuelMessageLeafIndexStr!),
  },
)
feeOption = { fee: { paymentMethod } }
```
Its execution payload is a single call:
```ts
// dest/fee/fee_juice_payment_method_with_claim.js:19-32
selector = FunctionSelector.fromSignature('claim_and_end_setup((Field),u128,Field,Field)')
args = [ sender /*=to*/, claimAmount, claimSecret, messageLeafIndex ]
```
So the user's own L2 claim tx pays its own gas from the just-claimed FJ. `claim_and_end_setup` places
the FJ credit in the non-revertible phase so the sequencer is guaranteed payment.

**PRIVATE fuel — `PrivateMintAndPayFeePaymentMethod` (from `@wonderland/aztec-fee-payment`):**
```ts
// dist/src/ts/fee-payment-methods/private.d.ts:25
constructor(fpcAddress: AztecAddress, amount: bigint, secret: Fr, salt: Fr, leafIndex: Fr)

// [holonym] frontend/src/hooks/useL1Operations.ts:913-919
const paymentMethod = new PrivateMintAndPayFeePaymentMethod(
  AztecAddress.fromString(privateFuel.fpcAddress),  // FPC (== fuelRecipient on L1)
  receipt.fuelAmount,                               // POST-FEE FJ amount
  backup.privateFuelSecret,                         // DERIVED secret (see below)
  backup.privateFuelSalt,                           // the random salt used to derive it
  new Fr(BigInt(receipt.fuelMessageLeafIndexStr!)),
)
```
Its execution payload is TWO private calls bundled into the tx setup phase, IN ORDER
(`dist/src/ts/fee-payment-methods/private.js:38-65`):
```
1. FeeJuice.claim(fpcAddress, amount, secret, leafIndex)
   selector: "claim((Field),u128,Field,Field)"      args: [fpcAddress, amount, secret, leafIndex]
     -> consumes the L1→L2 FJ message (to == fpcAddress), credits FPC's PUBLIC FJ balance, emits FJ nullifier.
2. PrivateFPC.mint_and_pay_fee(amount, salt, leafIndex)
   selector: "mint_and_pay_fee(u128,Field,Field)"    args: [amount, salt, leafIndex]
     -> asserts the FJ nullifier from step 1 exists,
        credits (amount - max_gas_cost) to msg_sender (== the USER) as private balance,
        sets the FPC as the tx fee payer and ends setup.
```
`getFeePayer()` returns `fpcAddress` (private.js:33-34). Net effect: one L2 tx, fully private; the FPC
pays the sequencer from its public FJ; the user gets the remainder as private wrapped-FJ. The user
never appears as the fee payer, so no observer links the gas payment to the user.

### Q: THE EXACT subtle bug/nuance they fixed — document precisely

There were **two** coupled fixes, both in commit `b21421a` ("fix: use BridgedMintAndPayFeePaymentMethod
for private fuel (correct flow)", authored after researching the fee-payment package). Verified via
`git show b21421a` on the Holonym repo.

**BUG 1 — wrong `claimer` in the secret derivation (the subtle one).**

The private-fuel claim secret is NOT random. It is derived deterministically so the FPC can
reconstruct it inside its circuit:
```
secret = poseidon2HashWithSeparator([salt, claimer], DOM_SEP_FPC_BRIDGE_SECRET)
DOM_SEP_FPC_BRIDGE_SECRET = 3952304070
// [holonym] frontend/src/app/api/compute-secret-hash/route.ts:26,44-47
```
The bug: `claimer` was originally set to `fpcAddress`. It MUST be the **user's Aztec address**.

```diff
-    // claimer = FPC address, computed server-side
+    // claimer = user's Aztec address (the contract uses msg_sender() as claimer)
-        claimer: params.privateFuel.fpcAddress,
+        claimer: params.aztecAddress,
```
Why: the PrivateFPC's `mint_and_pay_fee` runs with `msg_sender() == the user` (the user is the one
submitting the L2 claim tx). Inside the circuit the FPC re-derives the expected secret as
`poseidon2([salt, msg_sender])` to bind the bridged FJ to a specific claimer and recompute the
message/nullifier. If the off-chain secret were derived with the FPC address while the contract
derives with the user address, the two secrets differ → the `FeeJuice.claim` content hash /
`mint_and_pay_fee` assertion mismatches → the claim reverts. The fuel is locked on L1 with no way to
claim it via the FPC. This is a silent, fund-affecting bug that only surfaces at L2-claim time
(after L1 funds are committed). Commit message verbatim:

> "Secret derivation: claimer must be the USER's Aztec address, not the FPC address. The contract's
> mint() uses msg_sender() as claimer to reconstruct the nullifier — so the secret must be derived
> with the user's address: poseidon2([salt, userAddress], DOM_SEP)."

**BUG 2 — wrong claim topology (separate `mint` call instead of bundled claim+pay).**

The original code did `FeeJuice.claim(fpc, ...)` as a standalone tx, then a separate `mint` on the
FPC, then paid fees. The fix bundles `FeeJuice.claim` + `mint_and_pay_fee` into a SINGLE tx's setup
phase via the payment method. Commit message verbatim:

> "Use BridgedMintAndPayFeePaymentMethod instead of separate mint call. This bundles FeeJuice.claim +
> BridgedFPC.mint_and_pay_fee as a fee payment method for the token claim tx. Everything happens in
> ONE L2 transaction, all private — no doxing. The FPC pays the sequencer from its public FJ balance
> (credited by the claim), and the user receives (amount - gas_cost) as private wFJ."

The dead `executePrivateFuelL2ClaimAndMint` function and a separate "step 9b" were removed.

**Earlier coupled fix — `fuelRecipient` plumbing (commit `134e2db`, then `5ac45c6`).**
Before these, the L1 router had no way to send FJ anywhere but the user. `134e2db` added the
`fuelRecipient` field to the L1 struct/event/deposit call + frontend ABI so FJ could be deposited to
the FPC address for private fuel. Without it, private fuel was impossible (FJ would always land on the
user's public balance, defeating the privacy goal).

**NET RULE to copy faithfully:**
- Public fuel: `fuelRecipient = user`, random claim secret, `FeeJuicePaymentMethodWithClaim(user, {claimAmount: postFeeFJ, claimSecret, messageLeafIndex})`.
- Private fuel: `fuelRecipient = FPC`, **derived** secret `poseidon2([salt, USER_ADDRESS], 3952304070)`, `PrivateMintAndPayFeePaymentMethod(FPC, postFeeFJ, secret, salt, leafIndex)`.
- The `claimAmount` passed to either method is the **post-fee** FJ amount actually received on L2 (from the L1 deposit event), NOT the pre-fee amount the user requested.

> CAVEAT: if the FeeJuicePortal is the vanilla Aztec one (no `calculateFee`), the FJ amount
> is unchanged and `fuelReceived == requested`. Holonym's post-fee dance for FJ exists because their
> path runs the amount through a Uniswap swap (output is variable) and reads the actual received
> amount from the event. A clean bridge that deposits a fixed FJ amount directly (à la
> `bridge-script/fees.ts` → `bridgeTokensPublic`) reads `claim.claimAmount` straight from the
> `L1FeeJuicePortalManager` return value — no swap, no fee subtraction. Strongly prefer that path.

---

## Content-hash spec for the clean portal (exact signatures)

The token L1→L2 message content hash MUST match byte-for-byte on both sides or
`consume_l1_to_l2_message` fails (the message tree lookup uses the hash as the leaf preimage).

### L1 side (what the portal emits) — Holonym's `TokenPortal.sol`

```solidity
// PUBLIC: [holonym] l1-contracts/src/TokenPortal.sol:168-169
bytes32 contentHash =
    Hash.sha256ToField(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", _to, amountAfterFee));

// PRIVATE: [holonym] l1-contracts/src/TokenPortal.sol:193 (and :219 in the *For variant)
bytes32 contentHash =
    Hash.sha256ToField(abi.encodeWithSignature("mint_to_private(uint256)", amountAfterFee));

// WITHDRAW (L2→L1): TokenPortal.sol:242-246
content: Hash.sha256ToField(
    abi.encodeWithSignature("withdraw(address,uint256,address)", _recipient, _amount, _withCaller ? _msgSender() : address(0))
)
```

Key arg-order facts:
- **public** hash = `sha256ToField( selector("mint_to_public(bytes32,uint256)")[0:4] || to(32) || amount(32) )` → 68 bytes.
- **private** hash = `sha256ToField( selector("mint_to_private(uint256)")[0:4] || amount(32) )` → 36 bytes. **No recipient in the hash** — the L2 recipient is supplied privately at claim time and is therefore unlinkable to the L1 message.
- The L1 message recipient actor is `L2Actor(l2Bridge, rollupVersion)` (TokenPortal.sol:167,192) — i.e. the message is addressed to the L2 bridge contract.
- The amount baked in is **`amountAfterFee`**, not the gross `_amount` (TokenPortal.sol:164-165). The L2 claim must pass the post-fee amount.

### L2 side (what the bridge recomputes) — canonical `token_portal_content_hash_lib`

`[nargo-cache] token_portal_content_hash_lib/src/lib.nr` (exact pinned source, the same lib the bridge
imports at `[holonym] aztec-contracts/token_bridge/src/main.nr:28-31`):

```noir
pub fn get_mint_to_public_content_hash(owner: AztecAddress, amount: u128) -> Field {
    // selector = keccak256("mint_to_public(bytes32,uint256)")[0:4]
    // hash_bytes[0:4]=selector, [4:36]=owner BE, [36:68]=amount BE
    sha256_to_field(hash_bytes /* [u8; 68] */)
}
pub fn get_mint_to_private_content_hash(amount: u128) -> Field {
    // selector = keccak256("mint_to_private(uint256)")[0:4]
    // hash_bytes[0:4]=selector, [4:36]=amount BE
    sha256_to_field(hash_bytes /* [u8; 36] */)
}
pub fn get_withdraw_content_hash(recipient: EthAddress, amount: u128, caller_on_l1: EthAddress) -> Field {
    // selector = keccak256("withdraw(address,uint256,address)")[0:4]
    // [0:4]=selector, [4:36]=recipient, [36:68]=amount, [68:100]=caller_on_l1
    sha256_to_field(hash_bytes /* [u8; 100] */)
}
```
Note: Noir uses `keccak256(sig)` and L1 uses `abi.encodeWithSignature(sig, ...)` which internally
takes `keccak256(sig)[0:4]` — same selector. The body is the args ABI-encoded as fixed 32-byte
big-endian words, then `sha256` truncated to a field. **Matched by construction.**

### How the L2 bridge consumes it

```noir
// [holonym] aztec-contracts/token_bridge/src/main.nr:169-186 (claim_public)
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: Field) {
    let content_hash = get_mint_to_public_content_hash(to, amount);
    let config = self.storage.config.read();
    self.context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index);
    self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_public(to, amount));
}

// claim_private (main.nr:216-237)
fn claim_private(recipient: AztecAddress, amount: u128, secret_for_L1_to_L2_message_consumption: Field, message_leaf_index: Field) {
    self.enqueue_self._assert_not_paused();
    let content_hash = get_mint_to_private_content_hash(amount);  // recipient NOT in hash
    self.context.consume_l1_to_l2_message(content_hash, secret_for_L1_to_L2_message_consumption, config.portal, message_leaf_index);
    self.call(TokenMinterProxy::at(config.token_minter_proxy).mint_to_private(recipient, amount));
}
```

### What the CLEAN portal must reproduce (minus attestation)

The L1 TokenPortal `depositToAztecPublic`/`depositToAztecPrivate` should emit **exactly** these
content hashes — identical signatures, identical arg order. The attestation params
(`CleanHandsData`, `PassportData`) and `_validatePrivateAttestations` are layered as a separate gate
(TokenPortal.sol:187,213) and do **NOT** touch the content hash. The clean portal is therefore the
upstream canonical TokenPortal with two deviations to consider keeping or dropping:
- **Keep (optional):** the `fee`/`calculateFee` + `collectedFees` mechanism — only if a bridge fee is wanted. If kept, the `amountAfterFee` plumbing and the post-fee `claimAmount` in the frontend are mandatory. If dropped, hash the gross amount and the frontend simplifies (no event-amount readback).
- **Drop:** `_validatePrivateAttestations`, `CleanHandsData`, `PassportData`, `trustedForwarders`/`depositToAztecPrivateFor` (the latter only exists to let SwapBridgeRouter forward private deposits with attestations).

The L2 `claim_public`/`claim_private` need **zero** changes vs canonical — they already use the
canonical content-hash lib. Drop the attestation storage/verify code from `exit_to_l1_private` (see
TAKE vs DROP).

---

## token_minter_proxy shared-minter model

This is THE mechanism that guarantees "bridged asset == fauceted asset." Full file is short
(`[holonym] aztec-contracts/token_minter_proxy/src/main.nr`, 98 lines).

### Why it exists

The defi-wonderland token has a **single immutable minter**:
```noir
// [nargo-cache] aztec-standards/prerelease-1ad0e28/src/token_contract/src/main.nr:61
minter: PublicImmutable<AztecAddress, Context>,
// :475-477
fn _validate_minter(sender: AztecAddress, minter: AztecAddress) {
    assert(minter.eq(sender), "caller is not minter");
}
```
`mint_to_public`/`mint_to_private` call `_validate_minter(self.msg_sender(), self.storage.minter.read())`.
The token can only ever recognize ONE minter address, set once at construction
(`constructor_with_minter`, line 94-99). You cannot make both the bridge AND the faucet direct minters.

### The indirection

Set the **proxy** as the token's single `minter`. The proxy then keeps its OWN allow-list and
forwards mints to the token:
```noir
// authorization model — token_minter_proxy/src/main.nr
owner:    PublicImmutable<AztecAddress>            // set to deployer in constructor (:26)
token:    PublicImmutable<AztecAddress>            // set once via set_token() (owner-gated, :30-34)
can_mint: Map<AztecAddress, PublicMutable<bool>>   // the multi-minter allow-list

set_minter(minter, allowed)  // owner-gated (:55-59) — flips can_mint[minter]
is_minter(minter) -> bool    // view (:49-52)

mint_to_public(recipient, amount)   // PUBLIC  (:67-73)
  assert(can_mint[msg_sender()]);   //   gate
  Token::at(token).mint_to_public(recipient, amount);   // proxy is the token's minter

mint_to_private(recipient, amount)  // PRIVATE (:83-89)
  self.enqueue_self.assert_minter(msg_sender());  // gate via enqueued public check (:62-65)
  Token::at(token).mint_to_private(recipient, amount);

burn_public / burn_private          // same gate, forward to token burn (:75-97)
```

### How the bridge uses it

1. Deploy token with `constructor_with_minter(..., minter = proxy_address)`.
2. `proxy.set_token(token_address)`.
3. `proxy.set_minter(bridge_address, true)` — the bridge can now mint via the proxy.
4. `proxy.set_minter(faucet_address, true)` — the faucet can now mint via the SAME proxy → SAME token.

Both the faucet's direct mint and the bridge's portal-driven mint flow `proxy.mint_to_*` → identical
token → the bridged cToken and the fauceted cToken are the **same fungible asset**. The proxy is the
single trust anchor; `owner` controls who can mint. (`owner` is a `PublicImmutable` here — set once,
never transferable. If a revocable/transferable proxy owner is wanted, that's a deviation to design.)

> Note on the token side: the proxy must call the token method matching the desired domain.
> `mint_to_public` is `#[external("public")]`; `mint_to_private` is `#[external("private")]`. The
> proxy mirrors this (its `mint_to_private` is `#[external("private")]` and uses `enqueue_self` for the
> minter check because the allow-list read is public state read from a private context). Copy the
> public/private split verbatim.

---

## token_bridge L2 claim flow

### claim_public (consume → mint public)
`main.nr:168-186`. Args `(to, amount, secret, message_leaf_index)`. Asserts not paused + amount>0,
recomputes `get_mint_to_public_content_hash(to, amount)`, calls
`context.consume_l1_to_l2_message(content_hash, secret, config.portal, message_leaf_index)` (emits the
replay nullifier), then `proxy.mint_to_public(to, amount)`. Redeems straight to the recipient's public
balance.

### claim_private (consume → mint private)
`main.nr:216-237`. Args `(recipient, amount, secret_for_L1_to_L2_message_consumption, message_leaf_index)`.
Content hash is `get_mint_to_private_content_hash(amount)` — **recipient is not in the hash**, so the L1
message reveals only the amount; the actual L2 recipient is chosen privately at claim time. Consumes
the message, then `proxy.mint_to_private(recipient, amount)`. The amount is still public (it's in the
L1 message), so a claim can be correlated to an L1 deposit of the same amount if amounts are unique —
documented in the contract's own doc comment (main.nr:213-215).

### Message consumption mechanics (secret / secretHash)
- On L1, `inbox.sendL2Message(L2Actor(l2Bridge, version), contentHash, secretHash)` stores the message keyed by `(contentHash, secretHash)`; `secretHash = computeSecretHash(secret)` (poseidon2).
- On L2, `consume_l1_to_l2_message(contentHash, secret, portal, leafIndex)` re-derives `secretHash` from `secret`, looks the leaf up in the L1→L2 message tree, and emits a nullifier so it can't be consumed twice. The `portal` arg (= `config.portal`, the L1 TokenPortal EthAddress) binds the message to the expected L1 sender.
- `message_leaf_index` is the tree index emitted in the L1 deposit event (`index` field). The frontend extracts it and, if unknown, brute-forces 0..63 (`[holonym] bridge-sdk/src/l2.ts` / `bridgeL1ToL2.ts:467-500`).

### exit_to_l1 (withdraw, L2→L1)
- `exit_to_l1_public` (main.nr:190-211): `get_withdraw_content_hash(recipient, amount, caller_on_l1)`, `context.message_portal(config.portal, content)` (queues L2→L1 msg), then `proxy.burn_public(msg_sender, amount, authwit_nonce)`. Requires an AuthWit so the bridge can burn the caller's tokens.
- `exit_to_l1_private` (main.nr:328-397): same withdraw message, but **gated by Holonym attestations** (clean-hands or passport) before burning via `proxy.burn_private`. The attestation gate is the only Holonym-specific part; the withdraw content hash + `message_portal` + `burn_private` are canonical.

### Tests
`[holonym] aztec-contracts/token_bridge/src/test/token_bridge_tests.nr:434-445` explicitly documents
that `claim_public`/`claim_private`/`exit_to_l1_*` are **NOT** unit-tested in the TXE — they need the
`consume_l1_to_l2_message` oracle / cross-contract message-portal which the TXE lacks. They must be
covered by TypeScript e2e. The existing Noir tests only cover the attestation/Schnorr/nonce logic.
**Implication:** the content-hash correctness is NOT pinned by a Noir test; it is guaranteed
only by both sides using the identical canonical lib + signature strings. Unleashed should add a TS e2e
that does a real L1 deposit → L2 claim round-trip (and, if feasible, a unit assertion that the L1
`sha256ToField(...)` equals the Noir `get_mint_to_*_content_hash(...)` for fixed inputs, to catch
signature/arg-order drift early).

---

## TAKE vs DROP

### TAKE (copy faithfully, near-verbatim)

- **`token_minter_proxy` in full.** This is the shared-minter mechanism; it's identity-agnostic and exactly what guarantees faucet/bridge mint the same asset. Copy as-is. (Decide separately whether `owner` should stay `PublicImmutable` or become transferable.)
- **The canonical content-hash usage** in `token_bridge` `claim_public`/`claim_private`/`exit_to_l1_*` — they already use `token_portal_content_hash_lib`. Keep the lib import + the four arg-order-sensitive call sites verbatim.
- **The L1 deposit content-hash construction** in `TokenPortal.sol` (`mint_to_public(bytes32,uint256)` / `mint_to_private(uint256)` / `withdraw(address,uint256,address)`), minus the fee subtraction if no bridge fee is wanted.
- **The Fee Juice pipeline, both modes.** The public mode (`FeeJuicePaymentMethodWithClaim`) is pure Aztec — copy directly. The private mode (`PrivateMintAndPayFeePaymentMethod` + PrivateFPC) is reusable IF private gas is wanted; copy the secret-derivation rule (`poseidon2([salt, USER_ADDRESS], 3952304070)`) and the two-call bundling EXACTLY (this is where the bug lived).
- **`bridge-script/fees.ts` and `bridge-sdk/{l1,l2}.ts`** as the clean reference shape (no swap, no attestation) — closest to what a clean SDK should look like.
- **The post-fee `claimAmount` discipline** — only if the bridge keeps a bridge fee OR a swap. Otherwise drop it.

### DROP (Holonym identity / periphery — not part of a clean bridge)

- **All attestation code on L2:** `CleanHandsData`, `PassportData`, `GrumpkinPubKey`, `human_id_attester_pubkey`, `clean_hands_circuit_id`, `passport_signer_pubkey`, `*_nonces` maps, `verify_clean_hands_signature`, `verify_passport_signature`, `_verify_deadline`, `_consume_*_nonce_public`, `is_*_nonce_used`, `update_attestation_config`, and the Schnorr/`schnorr` dependency. Strip the attestation branch out of `exit_to_l1_private` (keep a plain private withdraw). Simplify the `constructor` to just `(token_minter_proxy, portal)`.
- **All attestation code on L1:** `_validatePrivateAttestations`, the attestation structs, `depositToAztecPrivateFor` + `trustedForwarders` (only exist for the router to forward attested private deposits).
- **The entire Uniswap swap-to-fuel periphery:** `SwapBridgeRouter.sol`, `UniswapFuelSwap.sol`, `bridgeWithFuel`, the `BridgeWitness`/Permit2 witness machinery, `buildFuelQuote`/`fuelPricing`/`fuelQuote`. The faucet can hand out gas Fee Juice directly (deposit a fixed FJ amount via `L1FeeJuicePortalManager.bridgeTokensPublic`) instead of swapping the bridged token into FJ. This also removes the swap-driven variable-output reason for the post-fee readback.
- **Holonym backend coupling:** the `/api/attestation/*`, the encrypted server-side claim-secret backup (`/api/bridge/operations`, datadog logging). The bridge holds secrets locally; no attestation server.

### Pause/ownership (judgment call)
`is_paused` + `set_paused` + the 2-step ownership transfer (`transfer_ownership`/`claim_ownership`) in
both the bridge and the portal are generic safety features, not identity-coupled. TAKE if the bridge wants
an emergency pause + admin; otherwise simplify away.

---

## Open questions for planners

1. **Is a private-fuel path wanted at all?** It pulls in the `@wonderland/aztec-fee-payment` PrivateFPC dependency + a deployed FPC instance + the deterministic-secret derivation (the bug-prone part). If gas privacy isn't a launch requirement, ship public fuel only (`FeeJuicePaymentMethodWithClaim`) and defer private fuel. Big complexity reduction.
2. **Bridge fee: yes or no?** Holonym's portal charges `calculateFee` and hashes `amountAfterFee`. If the bridge charges no bridge fee, hash the gross amount and delete the entire post-fee `claimAmount` plumbing in the frontend/SDK (simpler, fewer footguns). Confirm before copying.
3. **Fuel delivery: swap vs direct.** Holonym swaps the bridged token→FJ on L1 (variable output → must read the event). A clean design deposits a fixed FJ amount directly to the FeeJuicePortal (à la `bridge-script/fees.ts`). Direct delivery removes the swap router, the Permit2 witness, and the variable-amount readback. Recommend direct.
4. **Vanilla vs custom L1 TokenPortal.** With attestation + swap dropped, is there any reason the portal isn't just the upstream canonical `TokenPortal.sol`? If no bridge fee, it likely is — verify the canonical 4.2.0 TokenPortal's content-hash matches the lib (it does upstream) and skip the custom Solidity entirely.
5. **`token_minter_proxy.owner` immutability.** It's `PublicImmutable` (set once, non-transferable). For a faucet that may rotate operators, a transferable/2-step owner may be wanted — small Noir change, but it's a deviation from the copied source. Decide.
6. **Token version pin drift.** The proxy's `Nargo.toml` pins aztec-standards `prerelease-1ad0e28`; the local nargo cache also has `prerelease-f9af777` (used elsewhere). Both expose identical `mint_to_public(to,amount)`/`mint_to_private(to,amount)` single-recipient signatures, but Unleashed should pin ONE version repo-wide and confirm the `minter` model + mint signatures against that exact pin before wiring the proxy.
7. **Content-hash regression guard.** Since the Noir suite skips the claim paths, add a TS test asserting the L1 `Hash.sha256ToField(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", to, amt))` equals the Noir `get_mint_to_public_content_hash(to, amt)` for fixed vectors (and the private variant) — cheap insurance against selector/arg-order drift on either side.
8. **PrivateFPC Noir source availability.** Only the compiled artifact ships in `@wonderland/aztec-fee-payment`; the `.nr` source for `mint_and_pay_fee` (and the exact in-circuit `poseidon2([salt, msg_sender], 3952304070)` re-derivation) is not in the package. If the bridge takes the private path, fetch/audit the FPC source from the defi-wonderland repo to confirm the domain separator + claimer semantics still match `3952304070` at the pinned version.
