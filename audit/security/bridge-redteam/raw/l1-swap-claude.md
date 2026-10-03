# L1 fuel-swap red-team — UniswapFuelSwap.sol (+ MockSwapTarget arbitrary-target power)

**Auditor:** Claude (Opus 4.8) · **Cluster:** L1 swap (`packages/bridge-evm/src/UniswapFuelSwap.sol`, `mocks/MockSwapTarget.sol`)

Adversarial goal: steal user funds, drain the swap, strand value, or mis-price the fuel swap. Read in full: `UniswapFuelSwap.sol` (304), `MockSwapTarget.sol` (47), plus the calling guards in `SwapBridgeRouter.sol` (191-204) and the V4 `PoolManager` settle/sync/unlock primitives (`lib/v4-core/src/PoolManager.sol:103-363`, `CurrencyReserves.sol`).

## Verdict up front

`UniswapFuelSwap` is a **stateless, fund-less, per-call settler**. Between calls it holds no user funds (anything it holds is owner-`sweep`-able dust). Every external `swap()`:
1. pulls input from `msg.sender` (caller must have approved),
2. runs the V4 unlock,
3. enforces `output >= minOutput` (`:109`),
4. ships the FeeJuice to `msg.sender` and returns.

The V4 `unlock` wrapper *itself* reverts the whole tx if any currency delta is left unsettled (`PoolManager.sol:111` `CurrencyNotSettled`). That single invariant is what makes most "mismatched settle amount / stuck ETH inside the swap" attacks **non-exploitable for theft**: a wrong settle amount reverts the tx; it does not silently strand protocol money. The realistic residual risk is therefore **griefing / DoS of the caller's own tx** and **owner-key blast radius**, not third-party fund theft.

I found **no critical/high fund-theft vector** in this cluster. The strongest real issue is a **MEDIUM** sandwich exposure on the permissionless `swap()` entrypoint that the contract's own `minOutput` does NOT bound the way a reader expects (it bounds output, but the *caller* — when that caller is an EOA going direct, not the router — has no upstream slippage authority and no atomic intent binding). Plus two LOW/INFO items. The router-mediated path (the production path) is well-defended by the three router guards (`SwapBridgeRouter.sol:196,199,204`).

Detailed clearing of each hot-spot the prompt named is in §"Hot-spots cleared" — that clearing is itself a deliverable.

---

## FINDING L1-SWAP-1 (MEDIUM) — Permissionless `swap()` + owner-mutable `feeJuice`-as-output means `minOutput` bounds *price* but not *who is protected*; a direct EOA caller is sandwichable with no atomic-intent shield

**Property:** Integrity / Availability of value (caller funds). **Blast radius:** any party that calls `UniswapFuelSwap.swap()` directly (not through the router) on a thin/attacker-controlled hookless FeeJuice pool. **Funds at risk:** the slippage the caller leaves on the table — bounded by their own `minOutput`, but the caller-supplied `minOutput` can be 0 and there is no upstream re-quote/intent enforcement when the router is bypassed.

**Exploitability:** vector = public mempool sandwich on a low-liquidity hookless pool; complexity = standard MEV; privileges = none; interaction = none beyond the victim's own tx.

**Confidence:** moderate (it is a real loss path, but only when a caller bypasses the router and passes a weak `minOutput`; the production UI path goes through the router which binds `minFuelOutput` in the Permit2 witness).

**SWC/CWE:** SWC-114 (transaction-order dependence) / CWE-362 (race) / CWE-841 (improper enforcement of behavioral workflow — the slippage bound is delegated to an untrusted argument on a permissionless entrypoint).

**Trace (source→sink):**
- `swap(inputToken, inputAmount, minOutput, path, zeroForOnes)` is `external nonReentrant` with **no caller allowlist** — `UniswapFuelSwap.sol:88-94`. Anyone can call it.
- `_validateRoute` (`:228-274`) only checks the route *shape*: first sells `inputToken`, last outputs `feeJuice`, hookless, continuous. It says nothing about pool *liquidity* or *price*. The doc comment at `:253-257` is explicit: "a non-zero hooks address is an untrusted pool that the `minFuelOutput` slippage bound does not protect against" — but a **hookless** pool seeded by an attacker (a brand-new `(X, FeeJuice)` pool the attacker LP's at a garbage price) passes validation fine.
- The only loss bound is `require(output >= minOutput)` at `:109`. `minOutput` is a **caller argument**. A direct EOA caller (or a careless integrator) who passes `minOutput = 0` — or who computes it off a manipulable spot quote — eats the full sandwich.

**Concrete exploit (realistic values):**
- Attacker creates a hookless pool `(USDC, FeeJuice)` with thin liquidity, or targets the real `ETH/FJ` 200k pool which the live test (`DeployFuelLive.fork.t.sol:121-123`) already documents craters ~25% on an 8x-oversize fill.
- Victim calls `swap(USDC, 2_000e6, /*minOutput*/ 0, [USDC/FJ], [true])` directly.
- Attacker front-runs with a buy that moves the pool, victim swaps at the skewed price, attacker back-runs. Victim receives far less FeeJuice than spot; the `output >= 0` check passes. The attacker keeps the difference as LP/swap profit.

**Why the guards fail to stop it:** the three *strong* guards live in `SwapBridgeRouter` (`:196` floor, `:199` balance-delta, `:204` consumed-equals-fuel), not in `UniswapFuelSwap`. They protect the router-mediated flow because the router binds `minFuelOutput` into the Permit2 witness (`SwapBridgeRouter.sol:177,337`) so the signed intent caps slippage. A direct call to `UniswapFuelSwap.swap()` has none of that — `minOutput` is just whatever the caller typed.

**Is it a real protocol risk or only self-harm?** It is **caller self-harm + MEV-extractable**, not protocol-fund theft: the swap contract still nets out (it pulls `inputAmount`, settles, ships `output`, holds nothing). So the protocol's pooled funds are not stolen. But "users can be sandwiched to ~0 on a permissionless entrypoint with a caller-supplied floor" is a legitimate periphery finding because the contract advertises itself (`:80-87`) as a reusable swap primitive, and the route validator's hookless rule gives a false sense that "validated route ⇒ safe."

**Smallest fix (pick one):**
- (a) **Restrict `swap()` to the router** (an `onlyRouter`/allowlisted-caller modifier, router address set in constructor or owner-set). This matches how it's actually used and removes the standalone-primitive footgun entirely. Cheapest and tightest.
- (b) If it must stay permissionless, require `minOutput > 0` (`require(minOutput > 0, "zero floor")`) so a 0-floor sandwich is impossible, and document that callers MUST compute `minOutput` from an oracle/quote, not spot.

**PoC test idea (Foundry, fork or local V4):** `UniswapFuelSwapSandwich.t.sol`. Seed a thin hookless `(TOKEN, FJ)` pool. As `attacker`, swap to push price; as `victim`, `swap(TOKEN, amt, 0, route, dirs)`; as `attacker`, swap back. Assert `victim` FeeJuice-received is materially below the pre-sandwich spot quote, and that the call did **not** revert (proving the 0-floor offers no protection). Post-fix (a): assert a non-router caller reverts with `onlyRouter`. Post-fix (b): assert `minOutput == 0` reverts.

---

## FINDING L1-SWAP-2 (LOW) — `sweep` is `onlyOwner` but **not** `nonReentrant`, and the contract has a `receive()` + an owner-mutable `swapTarget`-style trust surface; the router's `sweep` IS guarded, the swap's is not (inconsistency + dust-griefing during a future stateful change)

**Property:** Integrity (defense-in-depth). **Blast radius:** owner only; today bounded to dust because the contract is stateless between calls. **Funds at risk:** none today; this is a latent-footgun / consistency finding.

**Exploitability:** vector = none exploitable by a third party today (sweep is `onlyOwner`, `:290`); the finding is that the guard asymmetry will bite if the contract ever gains persistent balances or a callback that runs mid-sweep. complexity = n/a; privileges = owner; interaction = a malicious `to` receiving ETH could reenter via `receive`-less `sweep` path… but there is nothing reentrant to exploit because no state mutates around the transfer.

**Confidence:** high that the asymmetry exists; low that it is exploitable today.

**SWC/CWE:** CWE-1188 (insecure default / inconsistent guard) / SWC-107 (reentrancy — preventive).

**Trace:**
- `SwapBridgeRouter.sweep` is `onlyOwner nonReentrant` (`SwapBridgeRouter.sol:287`).
- `UniswapFuelSwap.sweep` is `onlyOwner` only — **no `nonReentrant`** (`UniswapFuelSwap.sol:290`). It does a raw `payable(to).call{value: bal}("")` (`:296`) to an arbitrary owner-chosen `to`.
- Today there is no cross-function reentrancy because `sweep` reads `address(this).balance` fresh and the only other entry, `swap()`, is itself `nonReentrant` — but `sweep` is NOT on that lock, so `swap` and `sweep` do not mutually exclude. The `_locked` flag (`:42-49`) only guards `swap`/`unlockCallback` re-entry, not `sweep`.

**Why it's only LOW:** the contract holds no accounted state, so a reentrant `sweep` during a `swap` (e.g., a malicious `to` triggering another sweep) just moves the same dust and re-reads balance — no double-spend of accounted funds. But the asymmetry with the router's guarded `sweep` is a smell, and if a refactor ever parks funds here (e.g., batching), the unguarded `sweep` + `receive()` becomes a live reentrancy surface.

**Smallest fix:** add `nonReentrant` to `UniswapFuelSwap.sweep` to match the router and pre-empt the latent surface. (The contract already has the modifier defined.) One word.

**PoC test idea:** low-value; a regression/consistency test `test_sweepIsNonReentrant` that deploys a `to` contract whose `receive()` re-enters `sweep` and asserts the second call reverts post-fix. Pre-fix it succeeds harmlessly (documenting the gap).

---

## FINDING L1-SWAP-3 (INFO / acknowledged) — `setSwapTarget` arbitrary-target power is mitigated by the router's three guards, but there is **no timelock / no 2-step-on-target / no event-gated delay**; a compromised owner key can repoint the router to a hostile target within slippage

**Property:** Integrity (centralization). **Blast radius:** all in-flight bridges, capped at each user's own signed slippage. **Funds at risk:** per-tx, ≤ `totalAmount − minFuelOutput`-equivalent slippage, NOT the whole TVL (the contract holds no pooled funds).

**Confidence:** high (this is by-design centralization; flagged because the prompt asks whether a non-malicious deployment is missing a safeguard).

**SWC/CWE:** SWC-112 (delegatecall/loss of trust to untrusted target — here a typed external call) / CWE-269 (improper privilege management).

**Trace:** `SwapBridgeRouter.setSwapTarget` (`SwapBridgeRouter.sol:142-147`) is a single-tx `onlyOwner` repoint with an event but **no delay**. The `swapTarget` is also NOT bound in the Permit2 witness (the witness binds `routeHash`, not the executing target — `SwapBridgeRouter.sol:52-56,178`). So a user's signature authorizes "swap this route for ≥ minFuelOutput" but not "by *this* swap contract."

**Why it is bounded (this is the clearing):** even a fully hostile owner-set target cannot exceed the user's signed slippage, because the router re-checks ALL of:
- `fuelReceived >= p.minFuelOutput` (`:196`) — the SIGNED floor, re-enforced router-side precisely because the target is replaceable (the comment at `:194-195` calls this out),
- `fjBalAfter − fjBalBefore >= fuelReceived` (`:199`) — the target can't lie about delivery,
- `tokenBalBefore − balanceOf == p.fuelAmount` (`:204`) — the target MUST consume exactly the fuel slice; the `forceApprove(target, fuelAmount)` cap (`:190`) makes strict equality sound. This closes the `MaliciousPrefundSwap` residue-theft vector (a target that satisfies the floor from prefunded FJ without pulling the input — already pinned by `SwapBridgeRouter.t.sol:229-237`).

So a compromised owner gets at most "force every bridger to the edge of their own slippage" (a griefing/MEV-skim within signed tolerance), plus the ability to point at a target that reverts (DoS). It cannot drain principal or steal beyond signed slippage. **This is the right place to note the missing safeguard, not a fund-theft bug.**

**Smallest fix (defense-in-depth, optional):** put `setSwapTarget` behind a short timelock or a 2-step (`proposeSwapTarget` → `acceptSwapTarget` after N blocks) so a key compromise has a reaction window; OR bind `swapTarget` into the witness so a repoint invalidates outstanding signatures. Neither is required for correctness — both shrink the compromised-key blast radius.

**PoC test idea:** not a vuln PoC; an assertion test that a hostile target still cannot exceed signed slippage (largely already covered by `test_prefundedTargetNotConsumingSliceReverts` + `test_insufficientFuelReverts`). A new `test_hostileTargetCappedAtSignedSlippage` could pin that even a target returning exactly `minFuelOutput` while the route would have yielded more is the worst case.

---

## Hot-spots cleared (negative results — these are SAFE; clearing is a deliverable)

### #9 Settlement / native-ETH unwrap — **SAFE** (Cases A/B/C all balance; no stuck ETH, no theft, reentrancy is a no-op)

Full trace of `_settle` (`UniswapFuelSwap.sol:188-216`) against V4 primitives:

- **Case A (all-ERC20, `!lastPoolNative`, `:195-199`):** `sync(inputToken)` → `safeTransfer(poolManager, inputAmount)` → `settle()`. V4 `_settle` non-native branch (`PoolManager.sol:353-359`) computes `paid = balanceOf(poolManager) − reservesBefore = inputAmount` and resets the synced currency. The input delta the swap created is `-inputAmount`; `settle` credits exactly `inputAmount`. Net zero. Output FeeJuice taken at `:168`. ✔
- **Case B (single-hop native, `:200-203`):** `swap()` already pulled WETH from the caller (`:102`). `IWETH.withdraw(inputAmount)` (`:202`) converts the contract's own WETH to ETH (lands via `receive()` `:75`), then `settle{value: inputAmount}()`. No prior `sync` was called — but the transient `CURRENCY_SLOT` is 0 at unlock start, so V4 `_settle` reads `currency.isAddressZero()==true` → native branch → `paid = msg.value = inputAmount` (`PoolManager.sol:351-352`). The native input delta `-inputAmount` is cancelled. ✔ (V4's `:346` comment warns to `sync` native to avoid a *DoS* vector; here the only victim of that DoS would be the caller's own tx, and the production route doesn't even use Case B — see below.)
- **Case C (multi-hop, last pool native, `:204-214`):** Step 1 settles the input ERC-20 for the first hop(s) exactly like Case A (and crucially the non-native `_settle` resets the synced currency to 0 at `PoolManager.sol:359`). Step 2: `take(WETH, this, ethBridgeAmount)` pulls the intermediate WETH (the positive WETH delta produced by hop N-1), `withdraw` unwraps it, `settle{value: ethBridgeAmount}()`. Because step-1's settle reset the currency slot to 0, step-2's `settle` hits the native branch → `paid = msg.value = ethBridgeAmount`. ✔

**Can `ethBridgeAmount` diverge from what's owed?** No. `ethBridgeAmount` is captured as `currentAmount` at the *start* of the last iteration (`:141-143`) = hop N-1's output. The last-hop swap uses `amountSpecified = -int256(currentAmount)` (`:150`) = exact-input of that same amount, so the pool debits the contract exactly `ethBridgeAmount` native ETH. The contract `take`s exactly `ethBridgeAmount` WETH (= the WETH the prior hop credited it) and settles exactly `ethBridgeAmount` ETH. The three numbers are the same variable by construction. The route-continuity check (`:269-271`) guarantees hop N-1's output side is WETH and hop N's input side is native, so the WETH-delta-to-take actually exists. ✔

**Mismatched settle → stuck ETH?** If anything were off (e.g., a fee-on-transfer WETH, a rounding gap), the `_settle` would under/over-pay and **V4's `unlock` reverts the entire tx at `PoolManager.sol:111` (`CurrencyNotSettled`)**. There is no code path where a wrong settle silently leaves ETH stranded in the swap contract *and* lets the tx succeed. Worst case is a revert (caller's gas wasted), not theft or a permanent strand. Any genuine dust that does accrue (e.g., WETH 1-wei rounding) is owner-`sweep`-able (`:290`). ✔

**Reentrancy via `receive()` / `WETH.withdraw`:** `WETH.withdraw` calls back into `receive()` (`:75`), which is empty. The whole `swap()` is under `nonReentrant` (`:44-49,94`), and `unlockCallback` is PoolManager-gated (`:125`). Canonical WETH9's `withdraw` does `balanceOf[msg.sender] -= wad` *before* the ETH send and sends to `msg.sender` (this contract), so even a reentrant `receive` couldn't double-withdraw. No reentrancy. ✔

### Route validation (`_validateRoute` :228-274) — **SAFE against drain/mis-price within the documented model**

- First-hop-sells-`inputToken` / last-hop-outputs-`feeJuice` / hookless / continuity are all enforced (`:233-273`). The native-input branch correctly forces `inputToken == weth` (`:240-241`).
- **Attacker-created hookless pool with FeeJuice:** allowed by design — and bounded by `minOutput` for the router-mediated flow (witness-bound `minFuelOutput`). The *only* gap is the permissionless-direct-caller-with-weak-`minOutput` case, written up as **L1-SWAP-1**. The hookless rule does what it claims (blocks hook-based theft like a hook that re-enters or skims); it does not and cannot bound price — `minOutput` is the price bound, and it is sound when set correctly.
- **Multi-hop discontinuity / native-unwrap-only-on-last-hop:** the validator restricts the WETH↔ETH unwrap to the final boundary (`:266-271`), exactly matching `_settle` Case C's capability. A mid-route unwrap is rejected (`hop discontinuity`) — already pinned by `RouteValidation.t.sol:test_midRouteUnwrapRejected` (`:95-109`). I tried to construct a route that validates but mis-settles (e.g., unwrap at boundary 0 of a 3-hop) and it is correctly rejected. No bypass found. ✔
- **`feeJuice`-as-input zero-laundering:** a 1-hop `(feeJuice, X)` route fails "last hop must output feeJuice" unless the last hop outputs FeeJuice; a `(feeJuice, feeJuice)` pool can't exist (V4 `currency0 < currency1`, `PoolManager.sol:120`). No degenerate self-route. ✔

### `unlockCallback` auth (`:125`) — **SAFE / sufficient**

`require(msg.sender == address(poolManager))` is the canonical V4 guard. `unlock` is only ever called by this contract inside `swap()` (`:106`) with self-encoded `data`; the callback decodes that data (`:127-132`). An attacker cannot reach `unlockCallback` directly (msg.sender check) and cannot forge the `data` because they cannot make the PoolManager call this contract with attacker-chosen bytes — `unlock` passes back exactly the `data` the *caller of `unlock`* supplied, and only this contract calls `unlock`. The decoded `inputToken`/`path` are also re-derived from the same `swap()` args that already passed `_validateRoute`. No forge path. ✔

### Permissionless `swap()` + no-persistent-funds — **SAFE re: draining the contract**

Because the contract settles every call and holds nothing between calls, a permissionless caller cannot "drain" it — there is nothing to drain. The only abuse is self-sandwich (L1-SWAP-1) and griefing the swap into reverting (no protocol loss). The `nonReentrant` lock + per-call pull/settle make each call self-contained. ✔

### Integer bounds / negation — **SAFE**

- `inputAmount <= uint256(type(int256).max)` (`:98`) guards the `-int256(currentAmount)` negation (`:150`) for the *first* hop. Intermediate `currentAmount` values come from `uint256(int256(outputDelta))` where `outputDelta` is an `int128` proven `> 0` (`:159-161`); an `int128` always fits in `int256`, so later negations cannot overflow. ✔
- `outputDelta > 0` (`:160`) rejects zero/negative-output hops (e.g., a pool that would make the contract owe on the output side). ✔

### `SwapExecuted` event trust — **non-issue**

`grep` across `packages/**/*.ts` finds **no off-chain consumer** of `SwapExecuted`. Nothing trusts it for accounting; the router emits its own `BridgeWithFuel`/`Bridge` events and relies on return values + balance deltas, not the swap's event. Even if it did, the event is emitted after all guards. No finding. ✔

### `MockSwapTarget` (`mocks/MockSwapTarget.sol`) — **sandbox infra, no production finding**

Per the negative list, `MockSwapTarget` internals are not a production bug — it's the local-anvil stand-in (the real swap is exercised on the Sepolia fork, `DeployFuelLive.fork.t.sol`). The only in-scope angle is the router's `setSwapTarget`→arbitrary-target power, covered by **L1-SWAP-3**. Worth a one-line note: `MockSwapTarget.setRate` (`:30`) is unauthenticated, and `swap` uses raw `transfer`/`transferFrom` without `SafeERC20` — both fine for a mock, both would be bugs if it ever shipped, so it should stay clearly fenced as test-only (it imports from `../SwapBridgeRouter.sol` and lives under `mocks/`, so it won't be deployed by the production scripts). No action.

---

## Severity summary

| ID | Severity | Title | Funds-theft? |
|---|---|---|---|
| L1-SWAP-1 | MEDIUM | Permissionless `swap()` + caller-supplied `minOutput` ⇒ direct callers sandwichable; route validator's hookless rule gives false safety | No (caller self-harm / MEV, not protocol theft) |
| L1-SWAP-2 | LOW | `UniswapFuelSwap.sweep` missing `nonReentrant` (asymmetric with router's guarded sweep); latent surface | No |
| L1-SWAP-3 | INFO | `setSwapTarget` arbitrary-target has no timelock/2-step/witness-binding; bounded by router guards to signed slippage | No (capped at signed slippage) |

**No critical/high in this cluster.** The settlement/native-unwrap hot-spot #9, `unlockCallback` auth, route validation, integer bounds, and the permissionless-drain question all clear — the V4 `CurrencyNotSettled` unlock invariant + the router's three post-swap guards (`SwapBridgeRouter.sol:196,199,204`) are the load-bearing protections, and they hold.

**Worst finding:** L1-SWAP-1 (MEDIUM) — a sandwich/slippage exposure on the standalone permissionless `swap()` entrypoint, only reachable when the router is bypassed and a weak `minOutput` is passed; fix by restricting `swap()` to the router (preferred) or requiring `minOutput > 0`.
