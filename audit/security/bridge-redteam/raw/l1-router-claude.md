# L1 router red-team — SwapBridgeRouter.sol (+ MintableERC20, Permit2 witness, FJ portal iface)

**Cluster:** `packages/bridge-evm/src/SwapBridgeRouter.sol` (the crux), `MintableERC20.sol`,
`interfaces/ISignatureTransfer.sol`, `interfaces/IFeeJuicePortal.sol`.
**Model:** Opus 4.8. **Method:** static trace + 3 Foundry PoCs run locally against the real
router bytecode (all confirmed the conclusions, then removed).

## Verdict up front

The router's three guards (`SwapBridgeRouter.sol:196/199/204`) are **airtight for protecting
user funds**. I tried hard to break them and could not: the maximum a malicious or
owner-replaced `swapTarget` can extract from a user is **exactly the trade the user signed**
(`fuelAmount` of token → `minFuelOutput` Fee Juice on L2). Everything beyond the signed
slippage is bounded by the approval cap + the strict-consumption equality + the floor.

- **0 critical / 0 high** in this cluster.
- **1 LOW** (real, but bounded): `setSwapTarget` is an instant-effect, no-timelock governance
  knob whose blast radius is the signed-slippage band. This is the **router-side** twin of the
  swap cluster's `L1-SWAP-3`; I confirm it from the router side and bound the damage precisely.
- **1 INFO** (production footgun, testnet-acknowledged): `MintableERC20.allowance` infinite
  Permit2 override + permissionless mint.
- Hot-spots **#2 (residue/theft), #5 (arbitrary token), #6 (allowance theft path), #7 (EIP-712
  / replay), #10 (forceApprove / sweep)** — all **CLEARED**, with the reasoning + the exact guard
  that closes each below. Clearing these is the main deliverable.

---

## FINDING L1-ROUTER-1 (LOW) — `setSwapTarget` is instant-effect with no timelock, no per-target 2-step, no delay window; a compromised owner key can repoint the router to a hostile target that delivers the worst-case *signed* slippage on every future tx

- **CIA+A:** Integrity (of the swap leg), bounded. **Blast radius:** every future + in-mempool
  `bridgeWithFuel` call, but each capped at that user's own signed `minFuelOutput` floor.
  **Funds at risk per victim:** `(fairFuelOut − minFuelOutput)` worth of token — i.e. the
  slippage band the user already consented to (typically ≤3%). **Not** the bridge amount, **not**
  the principal.
- **Exploitability:** vector = owner-key compromise (or a malicious owner); complexity low once
  the key is held; privileges = owner (`Ownable2Step`); interaction = none from the victim beyond
  signing a normal bridge as usual.
- **Confidence:** high (the missing safeguard is plainly absent; the bounded blast radius is
  proven by PoC).
- **SWC/CWE:** CWE-284 (Improper Access Control — missing time-delay safeguard) / SWC-105-adjacent
  (privileged function without mitigations).
- **Trace (source→sink):**
  - `SwapBridgeRouter.sol:142` `setSwapTarget(address)` — `onlyOwner`, sets `swapTarget` in the
    same block, emits `SwapTargetUpdated` *after* the assignment (no delay, no pending-state).
  - `SwapBridgeRouter.sol:191` the next `bridgeWithFuel` immediately calls
    `swapTarget.swap(...)` on the new (attacker-chosen) target.
  - The new target receives `forceApprove(target, fuelAmount)` at `:190`.
- **Why the existing guards bound it (this is the important part):** I traced the worst a
  hostile target can do:
  1. It is approved for **exactly `fuelAmount`** (`:190`) and the approval is **reset to 0** at
     `:192` after `swap()` returns. It cannot touch the `bridgeAmount` (`totalAmount − fuelAmount`)
     — that is only approved at `:218`, after the swap, and `bridgeWithFuel` is `nonReentrant`, so
     the target cannot re-enter to grab a second approval.
  2. Guard `:204` `tokenBalBefore − balanceOf(this) == fuelAmount` (strict equality, capped by the
     `fuelAmount` approval) forces the target to consume **exactly** `fuelAmount` — it cannot pull
     more, and if it pulls less the tx reverts.
  3. Guard `:196` `fuelReceived >= minFuelOutput` + guard `:199`
     `fjBalAfter − fjBalBefore >= fuelReceived` force at least the user's signed floor of *real*
     FJ to land in the router, all of which is deposited at `:211`.
  - Net: a hostile target can only execute the user's signed worst-case (`fuelAmount` token for
    `minFuelOutput` FJ). The principal/bridge leg is untouchable. So this is LOW, not high.
- **Concrete scenario (realistic values):** Owner key leaks. Attacker deploys a target that
  pulls the full `fuelAmount` and delivers exactly `minFuelOutput` FJ (keeping the price upside).
  User bridges 1000 USDC, `fuelAmount=100`, quote≈ X FJ, `minFuelOutput = 0.97·X` (3% slippage).
  Attacker captures up to `0.03·X` worth across all victims. The user still bridges 900 USDC fine
  and receives `0.97·X` FJ — they get exactly what they signed.
- **Preconditions:** owner key compromise OR malicious owner. (Per the negative list, this is in
  scope *because* it reveals a missing safeguard a non-malicious deployment should have.)
- **Smallest-safe fix (pick one, low cost):**
  - Add a 2-phase `setSwapTarget`: `queueSwapTarget(addr)` + `applySwapTarget()` gated behind a
    short `block.timestamp` delay (e.g. 1–2 days), mirroring `Ownable2Step`'s philosophy. Users in
    the mempool get a window to stop bridging if a malicious target is queued.
  - Or, cheaper: bind the swap target into the Permit2 witness (add `address swapTarget` as field
    #12). Then a repoint **invalidates every outstanding signature** — the user's signature pins
    the exact target they trusted. This is the most surgical fix and also closes the conceptual gap
    in hot-spot #2 ("swapTarget not in the witness"). Cost: one witness field + the JS mirror
    (`bridge-core/src/l1.ts:87-99,118-152`) + the type-string in all three Solidity constants.
- **PoC test idea (Foundry):** `setUp` deploys router with an honest target + signs a witness for
  `(fuelAmount=100, minFuelOutput=0.97X)`. Malicious action: `router.setSwapTarget(hostile)` where
  `hostile` pulls 100 and returns exactly `0.97X` keeping the rest. Assert (pre-fix) the tx
  **succeeds** and the user received only `0.97X` while `hostile` retained the upside — and assert
  the bridge leg still got 900 (proving principal safety). With the witness-binding fix, assert the
  same call **reverts** at Permit2 (signature no longer matches because `swapTarget` changed).

---

## FINDING L1-ROUTER-2 (INFO) — `MintableERC20` grants Permit2 *infinite* allowance to every holder + permissionless capped mint; safe today, a severe footgun if copied to a value-bearing token

- **CIA+A:** none today (testnet faucet token, no value). **Blast radius (if generalized):** every
  holder of a token using this pattern. **Funds at risk today:** zero.
- **Exploitability:** none as a theft path — see "why it's safe" below.
- **Confidence:** high.
- **SWC/CWE:** CWE-732 (Incorrect Permission Assignment) — informational, by-design for testnet.
- **Trace:** `MintableERC20.sol:47-50` — `allowance(owner, PERMIT2)` returns
  `type(uint256).max` for **every** `owner`, unconditionally. `MintableERC20.sol:41-44` —
  `mint(to, amount)` is permissionless, capped at `maxMintPerTx`.
- **Why it is SAFE (no theft path — clears hot-spot #6):** the infinite allowance only satisfies
  the ERC-20 `transferFrom` that **canonical Permit2 itself** performs *after* it has verified the
  holder's EIP-712 signature (`permitTransferFrom` / `permitWitnessTransferFrom`). Permit2 will not
  move a single token without the owner's signature; the allowance override removes the *approve
  tx*, not the *authorization*. There is no path for a third party to call `transferFrom` directly
  as `PERMIT2` (they are not the Permit2 contract). Confirmed against the canonical Permit2
  semantics exercised in `test/SwapBridgeRouterPermit2Fork.t.sol` (`test_witnessTamperReverts`,
  `test_permit2NonceReplayReverts`, `test_permit2ExpiredDeadlineReverts` all revert without a valid
  signature).
- **Production footgun (the real INFO):** (a) the standard "set Permit2 allowance to 0 to revoke"
  safety net is gone — you can never lower it, so any future Permit2-class vulnerability or a
  leaked typed-data signature drains the holder with no user-side mitigation; (b) permissionless
  mint means anyone can flood supply (mitigated here only by `maxMintPerTx`, and only meaningful
  because the token is worthless). Both are fine for a faucet; both are catastrophic on a real
  asset. The contract header already says "BY DESIGN for a testnet faucet" — keep it there and
  ensure it never backs a value token.
- **Smallest-safe fix:** none required for the testnet faucet. Guard against copy-paste: a comment
  is present; consider a deploy-time `require(block.chainid != <mainnet ids>)` or a hard
  `IS_TESTNET` immutable that disables `mint`/the override on a production chain, if this code is
  ever reused.
- **PoC test idea:** already covered by `test/MintableERC20.t.sol`
  (`test_permit2IsPreApprovedForEveryHolder`, `test_nonPermit2AllowanceIsNormal`). To pin the
  *non-theft* property, add: a non-Permit2 EOA calling `transferFrom(victim, attacker, x)` with no
  approval **reverts** `ERC20InsufficientAllowance` — proving the override is Permit2-scoped only.

---

## Hot-spots CLEARED (negative results — these are SAFE; clearing is a deliverable)

### #2 — swapTarget not in the witness; the three guards; "excess FJ → residue" — **CLEARED for user funds**

The grounded concern was: can a malicious/replaced target steal beyond the signed
`minFuelOutput`, or strand owner-sweepable residue? Both legs of this resolve to **no user-fund
loss**:

- **Stealing beyond the floor:** impossible. Bounded by approval cap (`:190` = `fuelAmount`) +
  strict-consumption equality (`:204`) + the floor/balance-delta guards (`:196`/`:199`).
  Quantified in L1-ROUTER-1 above: max extraction = the signed slippage band. The
  `MaliciousPrefundSwap` pure-prefund attack (deliver from reserve, pull **nothing**) is closed by
  `:204` and already pinned by `test/SwapBridgeRouter.t.sol:test_prefundedTargetNotConsumingSliceReverts`.
- **"Excess FJ → residue" (the `>=` at `:199` vs exact `fuelReceived` deposit at `:211`):**
  **confirmed real but harmless.** I wrote a PoC (`OverdeliverSwap`: pulls exactly `fuelAmount`,
  reports `minFuelOutput`, but transfers `minFuelOutput + surplus` FJ from *its own* reserve). All
  three guards pass; only `fuelReceived` (= the floor) is deposited to L2; `surplus` FJ is stranded
  in the router as owner-sweepable residue. **But:** the surplus came from the *attacker's* reserve,
  the user received **exactly** their signed floor on L2, and the user paid **exactly** `totalAmount`.
  Loser = the attacker (donating FJ); user is whole. PoC asserted: `feePortal.lastAmount == floor`,
  `userPaid == totalAmount`, `fj.balanceOf(router) == surplus`.
  - With the **real** `UniswapFuelSwap`, return value == `poolManager.take` amount == the
    `safeTransfer(msg.sender, output)` amount, so the FJ delta equals `fuelReceived` *exactly* and
    residue is **zero** (pinned by `test/SwapBridgeRouter.t.sol:test_bridgeWithFuelPublic` asserting
    `fj.balanceOf(router) == 0`). Residue only arises with a hostile target over-delivering its own
    funds — a non-event.
  - **Hardening nicety (not a finding):** changing `:199` from `>=` to `==` would make the
    contract reject any over-delivering target outright, eliminating even attacker-donated residue.
    Purely defensive; no user benefit since the floor already protects them.

### #5 — arbitrary `bridgeToken` / `tokenPortal` (fee-on-transfer / rebasing / reentrant / lying ERC-20) — **CLEARED: self-harm only**

I PoC'd a 1% fee-on-transfer `bridgeToken`. Trace: the Permit2 pull of `totalAmount` burns 1% →
the router only ever holds 990; the swap pull of `fuelAmount` deducts exactly 100 from the router
(burn comes off the 100, so guard `:204` `delta == fuelAmount` *passes* — note this guard does
**not** catch fee-on-transfer); the shortfall surfaces at the final `:220/:223` token-portal
deposit when the router tries to forward `bridgeAmount = 900` while holding only 890 →
`ERC20InsufficientBalance` → the **whole tx reverts atomically**. PoC asserted post-revert:
`fot.balanceOf(router) == 0`, `fj.balanceOf(router) == 0`, `tokenPortal.lastAmount == 0` (no
half-bridged state, no residue). A clean-token control at the same params bridges fine, isolating
the cause.
- **Conclusion:** a weird/hostile token only blocks **its own caller**. No guard is broken that
  harms the protocol or other users; no funds are stranded (atomic revert). The `bridgeToken` /
  `tokenPortal` being arbitrary is a self-DoS surface, not a theft surface.
- **Adjacent edge cleared:** `bridgeToken == FeeJuice` (the underlying). Then `fjBalBefore ==
  tokenBalBefore`; after the swap, guard `:199` becomes `(before − fuelAmount + fuelReceived) −
  before >= fuelReceived` ⟹ `−fuelAmount >= 0` ⟹ **reverts**. Bridging FJ-as-token is rejected
  safely. Non-finding.
- **Reentrant token callback:** a malicious token's transfer hook cannot re-enter `bridgeWithFuel`
  / `bridge` / `sweep` — all are `nonReentrant` (OZ `ReentrancyGuard`). Confined.

### #6 — `MintableERC20.allowance` infinite Permit2 override — **CLEARED of theft** (see L1-ROUTER-2)

No theft path: Permit2 still requires the owner's signature. Documented as a production footgun
only.

### #7 — EIP-712: `BRIDGE_WITNESS_TYPEHASH` ⟺ `BRIDGE_WITNESS_TYPE_STRING` ⟺ `_hashBridgeWitness` ⟺ JS mirror; spender + chainId binding — **CLEARED: mutually consistent, no cross-router/cross-chain replay**

- **Field-order triple-check (all 11 fields, same order, same types):**
  - `BRIDGE_WITNESS_TYPEHASH` (`SwapBridgeRouter.sol:52-53`)
  - `BRIDGE_WITNESS_TYPE_STRING` (`SwapBridgeRouter.sol:55-56`) — embeds the identical
    `BridgeWitness(...)` member list, then `TokenPermissions(address token,uint256 amount)`.
  - `_hashBridgeWitness` `abi.encode` order (`SwapBridgeRouter.sol:325-342`) — matches field-for-field.
  - JS mirror `BRIDGE_WITNESS_TYPE` / `BRIDGE_WITNESS_PERMIT_TYPES.BridgeWitness` /
    `hashBridgeWitness` (`bridge-core/src/l1.ts:11-14,87-99,118-152`) — matches, and is pinned to
    the on-chain hash by `bridge-core/src/l1.test.ts` (fixed `WITNESS_HASH`) and the Solidity side
    by `test/WitnessHash.t.sol` (same fixed vector `0x6805573f...`). Drift is a CI failure.
- **EIP-712 nested-type ordering:** I reconstructed the full Permit2 type string the contract
  passes and confirmed it is well-formed:
  `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256
  deadline,BridgeWitness witness)BridgeWitness(...)TokenPermissions(...)`. The two referenced
  structs appear **alphabetically** (`BridgeWitness` before `TokenPermissions`, "B" < "T"), exactly
  as EIP-712 requires for the encodeType tail. (Verified with a throwaway Foundry probe; not a
  DoS, not type-confusion.)
- **Replay binding:** the signed digest binds `spender = address(router)` (in the typed
  `PermitWitnessTransferFrom` struct) and the EIP-712 domain binds `chainId` +
  `verifyingContract = Permit2`. So a signature **cannot** be replayed against another router,
  another chain, or after a `setSwapTarget` change *of any field that is in the witness* (note:
  `swapTarget` is **not** in the witness today — see L1-ROUTER-1 for the fix that would also pin it).
  Confirmed end-to-end against the **real** Permit2 in
  `test/SwapBridgeRouterPermit2Fork.t.sol:test_witnessTamperReverts` (tampering `aztecRecipient`
  after signing reverts) + `_sign` at `:208-217` (the digest is built with `address(router)` as
  `spender`). Nonce-replay and expiry also revert (real Permit2 bitmap + deadline).
- **fuelRecipient / aztecRecipient binding (asked in the prompt):** both are witness fields (#5,
  #6), so a relayer cannot redirect either the bridged token recipient *or* the FJ recipient after
  the user signs. The router passes `p.aztecRecipient` to `depositToAztecPublic` (`:223`) and
  `p.fuelRecipient` to the FJ portal (`:211`) — the same values that were hashed into the witness.
  No re-aim possible.

### #10 — `forceApprove`-to-zero discipline + `sweep` — **CLEARED: no allowance/funds survive the tx boundary; sweep is not a user-theft vector**

- **Every approval is reset to 0 in the same tx:** swap target `:190→:192`; FJ portal
  `:210→:212`; token portal `:218→:225` (and `bridge()` `:268→:278`). No path leaves a standing
  allowance.
- **Zero balance between calls:** the success paths assert `usdc.balanceOf(router) == 0` and
  `fj.balanceOf(router) == 0` (`test/SwapBridgeRouter.t.sol:202-204,258`). So `sweep` only ever
  grabs *genuine* residue (accidental transfers, or attacker-donated surplus per #2) — never a
  user's in-flight principal.
- **Sweep cannot front-run a victim mid-flight:** `sweep` is `onlyOwner` **and** `nonReentrant`,
  and so is `bridgeWithFuel`; they cannot interleave within a single tx, and across txs the router
  holds nothing. (Contrast: the *swap* contract's `sweep` is **not** `nonReentrant` — that's the
  sibling cluster's `L1-SWAP-2`, out of my file's scope.)

### Public-FJ-deposit-always (even when `isPrivate`) — **CLEARED: no recipient leak**

The prompt flagged the FJ leg always being a *public* deposit (`:211`,
`feeJuicePortal.depositToAztecPublic`) even when the token leg is private. I traced the private-fuel
design (`bridge-core/src/private-fuel.ts`, `flows.ts:216-220`): when `isPrivate`, the witnessed
`fuelRecipient` is the **fixed Wonderland `PRIVATE_FPC_ADDRESS`** (not the user's L2 address), and
`fuelSecretHash` is a **claimer-bound** secret (`deriveBridgeSecret(salt, claimer)`); the user
later claims via `PrivateFPC.mint_and_pay_fee`, which re-derives the secret from `msg_sender` on
L2. So the always-public FJ deposit reveals only "someone funded the FPC" — it does **not** link
the FJ to the private token recipient. The privacy boundary holds; the public deposit is the
intended mechanism, not a leak. (A *random* fuel secret on the private path would strand the FJ —
that's an availability concern handled in the JS layer, flagged in the JS-light cluster, not a
router-contract bug.)

---

## Severity summary (this cluster)

| ID | Title | Severity | Confidence |
|----|-------|----------|-----------|
| L1-ROUTER-1 | `setSwapTarget` instant-effect, no timelock / not witness-bound (bounded to signed slippage) | **LOW** | high |
| L1-ROUTER-2 | `MintableERC20` infinite Permit2 allowance + permissionless mint (testnet footgun) | **INFO** | high |
| — | #2 residue / hostile-target theft | **CLEARED** (user funds safe; residue = attacker self-harm) | high |
| — | #5 arbitrary token (fee-on-transfer / reentrant) | **CLEARED** (atomic revert, self-harm only) | high |
| — | #6 Permit2 allowance theft path | **CLEARED** (signature still required) | high |
| — | #7 EIP-712 consistency + replay binding | **CLEARED** (consistent; spender+chainId bound) | high |
| — | #10 forceApprove / sweep | **CLEARED** (zero residue across tx boundary) | high |

**Single most serious finding:** L1-ROUTER-1 — `setSwapTarget` has no timelock and is not bound in
the Permit2 witness, so a compromised owner key can repoint the router to a hostile target. The
damage is **bounded to the user's signed slippage band** by the three guards (proven), so it's LOW,
not high — but the cleanest fix (bind `swapTarget` as witness field #12) closes both this and the
conceptual gap in hot-spot #2 in one move.

## Notes for the reduce step

- No overlap-claim with the `l1-swap` cluster's `L1-SWAP-3`: that flags the **swap contract's**
  owner knob; L1-ROUTER-1 is the **router's** `setSwapTarget` from the router side, where the
  guards live. They share the recommended witness-binding fix.
- All three router guards were exercised against the real router bytecode via throwaway Foundry
  PoCs (`OverdeliverSwap`, `FeeOnTransferToken`, an EIP-712 type-string probe). They confirmed the
  conclusions above and were removed. The existing committed suite
  (`test/SwapBridgeRouter.t.sol`, `WitnessHash.t.sol`, `SwapBridgeRouterPermit2Fork.t.sol`,
  `MintableERC20.t.sol`) already pins the primary guard behaviors; 31/31 non-fork tests pass.
