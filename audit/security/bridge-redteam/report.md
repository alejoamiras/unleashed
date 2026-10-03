# Harden Report: security — bridge smart contracts (L1 + L2)

**Effort:** max · **Run ID:** bridge-redteam
**Models:** Opus 4.8 (Fable substitute, per user) for mapping/clusters/coordination/verification; Codex xhigh for two cross-model passes.
**Scope:** L1 Solidity (`SwapBridgeRouter`, `UniswapFuelSwap`, `MintableERC20`, `MockSwapTarget`, vendored `TokenPortal`), L2 Noir (`token_bridge`, `token_minter_proxy`, `keystone`), deploy/wiring scripts, and a light pass on the JS bridge-payload builders. Excluded: OZ/Uniswap-v4-core/Permit2/canonical-Aztec internals (audited our *wiring* of them, not their bodies); generated `out/`.

## Executive summary

The bridge's **application logic is solid** — the parts the team wrote (the Permit2 witness binding, the three fuel-swap guards, the V4 settlement, the minter allowlist, the pause, the JS payload construction) held up to adversarial red-teaming across two model families. Roughly ten attack hypotheses were actively tried and **cleared with reasoning** (see "Cleared"), including the most tempting one — a malicious/owner-replaced swap target — which is bounded to the user's signed slippage by airtight guards.

The serious exposure is **not in the swap/approve/permit2 path the user worried about — it's in initialization and operational authority.** One **CRITICAL**: the vendored canonical `TokenPortal` has a guardless, permissionless `initialize`, and it is **live on Sepolia** at the address the shipping faucet deposits into — any EOA can re-point its `underlying`/`l2Bridge`/messaging stack and drain the held reserves. This was **executably proven** against the real deployed bytecode (fork PoC, passing). Two **HIGH**s follow: the L2 minter proxy is an *immutable-owner*, uncapped print-and-withdraw backdoor into L1 reserves; and the contract test suite + the cross-chain content-hash keystone are **not run in CI**, so a future Aztec bump could silently strand every deposit. The remainder are medium/low (an unbound `swapTarget`, a fail-open library helper, a permissionless direct-swap, the accepted-risk bearer-secret).

**Priorities:** (1) F-003 is hours of work and the cheapest insurance against silent strand — land it first. (2) F-001 and F-002 require forks/redeploys + a **migration of the live testnet deployment** — they are unfixable in place. Treat the current Sepolia portal + minter-proxy owner key as compromised-by-design until migrated. Nothing here blocks testnet experimentation, but **none of F-001/F-002 should survive into any mainnet/value-bearing deployment.**

## Methodology

Map-reduce per the harden skill, with documented deviations (the skill explicitly prefers honest deviation notes over pretending the spec was followed):

- **Tool-fit override (stated to the user, who chose "harden as typed"):** `/harden` normally routes smart contracts to the `security-audit` skill and its agents are told *not* to flag contract vulns. That rule was overridden: the contract clusters got a smart-contract red-team taxonomy (reentrancy, access control, signature replay, EIP-712/witness completeness, re-init, slippage/MEV, content-hash forgery/strand, minter authority, cross-chain message validation) instead of the web-app CWE list. JS clusters kept the web prompt (light pass per user).
- **Phase 1 (map):** done by the main agent (Opus 4.8) reading all ~1,260 in-scope LOC directly + writing `raw/repo-map.md`, rather than spawning an `Explore` mapper. Justified: the surface is small enough that direct ground-truth read makes the main agent a far better coordinator/verifier and catches agent hallucinations.
- **Phase 2 (map):** 5 Opus 4.8 per-cluster auditors (l1-router, l1-swap, l1-portal-xchain, l2-noir, js-light) **plus 2 Codex xhigh passes** organized per-chain-surface (L1 Solidity; L2-Noir + cross-chain + JS) rather than 1 Claude + 1 Codex per cluster. Justified: the surface is small and the highest risks are *cross-chain flows* (L1 deposit → L2 claim content-hash match), which per-cluster Codex isolation would miss; whole-chain Codex passes preserve cross-cluster taint visibility.
- **Phase 2.5 (cross-rebuttal):** absorbed into reduce. The two independent Codex passes + the main agent's ground-truth read serve as the cross-model challenge; convergence vs divergence is tracked per finding (`findings/verified.md`).
- **Phase 3 (reduce):** main agent (Opus 4.8) coordinator (spec calls for a Codex coordinator at max; deviation) — dedup by root-cause + sink + boundary, CVSS bands assigned here, cross-model convergence used as the confidence signal.
- **Phase 4 (verify):** main agent re-read each cited trace against source, spot-verified the load-bearing facts (live portal address, proxy-owner immutability, CI gap, witness field order), and **executed the F-001 PoC on a live Sepolia fork (passing).**
- **Inter-procedural cap** ~4 functions with handoff-edge escalation across the L1↔L2 boundary (content-hash match, deposit→claim). Negative list applied (no OZ/Uniswap/Permit2/canonical-Aztec internals; mocks/keystone only re: production wiring).
- PoC `.t.sol` was run inside `packages/bridge-evm/test/`, verified, then moved to `poc/` so the package tree stays clean.
- Codex sessions: L1 `019ec80d-91fd-7be0-9326-fd2def5753a4`, L2/xchain `019ec80d-95e9-7032-ad7d-a6a2a36d91c1`.

**Finding density:** 11 reported across 5 clusters (~2.2/cluster), with ~10 hot-spots cleared — consistent with a real surface where the negative list held.

---

## Findings

### [CRITICAL — CVSS 9.3] F-001: `TokenPortal.initialize` is permissionlessly re-callable on the LIVE portal
**Impact:** Critical (integrity + availability; full held-reserve drain + deposit redirect). **Confidence:** high. **Mapping:** CWE-665 / CWE-284 / SWC-118. **Found by:** Claude + Codex (×3 independent passes). **Status:** executably proven on real bytecode.

**Instances:**
- `packages/bridge-evm/upstream/TokenPortal.sol:37-46` (guardless `initialize`)
- `packages/bridge-evm/upstream/TokenPortal.sol:126-149` (`withdraw` trusts the re-pointed `outbox`/`underlying`)
- Live: `packages/faucet/public/testnet-bridge.json:5` → `0x9c41d1DD627ed53E25702590ab974d9DfA0c11Ea` (UI-wired via `packages/faucet/src/contracts/bridge-deployments.ts:18`)
- Separate-tx deploy/init window: `packages/bridge-core/scripts/deploy-bridge-testnet.ts:113,191`, `deploy-sandbox.ts:105,173`, `deposit-testnet.ts:101,176`

**Description.** The vendored canonical Aztec `TokenPortal` is a *reference/test* portal whose `initialize(address registry, address underlying, bytes32 l2Bridge)` has no `onlyOwner`, no `initializer` modifier, and no first-call guard. Unleashed deploys it as production infra and initializes it in a **separate transaction** minutes after deploy. The result is two compounding problems: a multi-minute public front-run window at deploy, and — worse — a **permanent** ability for anyone to call `initialize` again at any time.

**Trace (drain).** `initialize` re-derives `rollup = registry.getCanonicalRollup()` and thus `outbox`/`inbox` from the **caller-supplied** registry (`:42-45`). An attacker deploys a fake registry → fake rollup → fake outbox, then:
1. `portal.initialize(fakeRegistry, realUSDC, anyBridge)` — keeps `underlying` as the real token.
2. `portal.withdraw(attacker, heldBalance, false, Epoch.wrap(0), 0, new bytes32[](0))` → `outbox.consume(...)` hits the **attacker's** no-op outbox (`:146`) and returns success → `underlying.safeTransfer(attacker, heldBalance)` (`:148`) drains the real reserves. Alternatively, re-pointing `inbox` makes every future `depositToAztec*` (`:74,:106`) emit the L1→L2 message into the attacker's inbox — tokens pulled on L1, never minted on real L2.

**Why guards fail.** There are none. The L2 bridge trusts the portal *address* + content hash, not the L1 `underlying`/`l2Bridge`, so it cannot detect a mutated portal. The vendored body is keccak-pinned (`verify-l1.ts:51-66`), so it can't be patched in place — the fix must fork it.

**PoC — VERIFIED PASSING** (`poc/PortalReinit.t.sol`, Sepolia fork against the real deployed bytecode):
```
live underlying (before): 0xA40A2FE147b7e96325d7c7D974B1f11C3ED82c68   (real AZLO USDC)
live l2Bridge (before):   0x0e31670a…748e                              (real AZLO bridge)
[PASS] test_F001_attacker_reinitializes_the_LIVE_portal()
F-001 CONFIRMED: live portal is permissionlessly re-initializable
```

**Fix.** Fork the vendored portal and add, as the first line of `initialize`, `if (address(registry) != address(0)) revert AlreadyInitialized();` (re-run the keccak pin against the fork). Deploy + initialize **atomically** (factory constructor or a single broadcast bundle), and have the deploy script **read back** `registry()/underlying()/l2Bridge()` and assert they equal the intended values before writing `testnet-bridge.json`. The currently-deployed `0x9c41…11ea` is **unfixable in place — migrate it.** After the fix, flip the PoC's second `initialize` to `vm.expectRevert(AlreadyInitialized.selector)` as the regression test.
**Effort:** days (fork + re-pin + redeploy + migrate live funds/UI config).

---

### [HIGH — CVSS 8.1] F-002: L2 `TokenMinterProxy` owner is an immutable, uncapped print-and-withdraw backdoor into L1 reserves
**Impact:** High (integrity; free L2 mint → L1 reserve drain). **Confidence:** high. **Mapping:** CWE-266 / CWE-284. **Found by:** Claude + Codex.

**Instances:**
- `packages/bridge-aztec/token_minter_proxy/src/main.nr:24-27` (owner = deployer, `initialize`-only — **no transfer/rotate path**, verified by grep)
- `…/token_minter_proxy/src/main.nr:55-58` (`set_minter` authorizes any address), `:68-72,:84-88` (authorized minter mints arbitrary amounts to anyone)
- `packages/bridge-aztec/token_bridge/src/main.nr:126-145` (`exit_to_l1_*` turns minted supply into an L2→L1 withdrawal) → `TokenPortal.sol:146-148` (releases L1 underlying)
- Wiring authorizes only the bridge today: `deploy-bridge-testnet.ts:185`, `deploy-sandbox.ts:166`, `deposit-testnet.ts:170`

**Description.** The minter proxy's owner can authorize any minter, and any authorized minter mints unbounded supply. Unlike the `TokenBridge` (which has 2-step ownership), the **proxy owner is set once at construction with no way to transfer or renounce it** — a single deployer EOA key is a permanent, unrotatable, total-failure point. A compromise yields: `set_minter(attacker,true)` → `mint_to_public(attacker, huge)` → `exit_to_l1_public` → consume on L1 → drain the portal's USDC. The bridge's own `is_paused` does not cover the proxy (pause lives on the bridge; the attacker calls the proxy directly).

**Why it matters.** The blast radius is the entire L1 reserve, not just L2 supply, and the immutable owner means there's no path to a multisig/timelock without a redeploy. This is the operational counterpart to F-001: even a perfectly-initialized portal is drainable through a compromised proxy-owner key.

**Fix.** Add 2-step ownership to the proxy (mirror the bridge's pattern) and transfer it to a multisig/timelock; after bootstrap, freeze the minter set (or enforce a single-minter == canonical-bridge invariant); consider a per-call/epoch mint cap. Minimum bar before any value deployment: the proxy owner must not be a hot EOA.
**PoC sketch.** aztec.js/TXE: `owner.set_minter(attacker,true)` → attacker `mint_to_public(attacker, N)` → `exit_to_l1_public` → (L1) consume the outbox message → assert portal USDC balance dropped by N.
**Effort:** days (ownership redesign + redeploy).

---

### [HIGH — CVSS 7.5] F-003: Contract tests + the cross-chain content-hash keystone are not CI-enforced → a bad bump silently strands all deposits
**Impact:** High (availability; permanent strand of all future deposits/withdrawals after a bad change). **Confidence:** high. **Mapping:** CWE-1059 / CWE-353. **Found by:** Claude + Codex (×3).

**Instances:**
- No `forge test`/`nargo test` anywhere in `.github/workflows/` (verified: `rg 'forge test|nargo' .github/workflows` → none). `Quality / Status` = Biome + vue-tsc + bun audit only (`_lint-and-typecheck.yml`).
- The guards exist but never run: `packages/bridge-aztec/keystone/src/main.nr`, `packages/bridge-evm/test/ContentHash.t.sol`, `WitnessHash.t.sol` (the latter only `console.log`s — doesn't `assertEq`, so the witness pin is one-directional), `SwapBridgeRouter.t.sol`, the Permit2 fork test. `packages/bridge-evm/package.json` has no `test` script.

**Description.** The L1 selectors (`mint_to_public(bytes32,uint256)` / `mint_to_private(uint256)` / `withdraw(address,uint256,address)`) and the L2 Noir content-hash vectors **match byte-for-byte today** (verified). But the equality is pinned as *hardcoded literals* that nothing recomputes in CI. A future Aztec-toolchain bump (or a forked-portal edit) that drifts a selector/encoding would leave green CI while making `consume_l1_to_l2_message` revert forever — every deposit pulls tokens on L1 and is unmintable on L2. This is the exact strand boundary the keystone was written to guard, with the guard disconnected from the pipeline.

**Fix.** Add a paths-filtered `bridge-contracts.yml` (triggers on `packages/bridge-evm/**` + `packages/bridge-aztec/**`) running `forge test` and `nargo test` (pinned rc.2 toolchain) + `verify:l1`; make it a required check. Convert `WitnessHash.t.sol`'s logs to `assertEq` so the witness pin is bidirectional like the content-hash keystone. Add `"test:contracts": "forge test"` to `bridge-evm` and a `nargo test` script to `bridge-aztec`.
**Effort:** hours. **Cheapest high-value fix — land first.**

---

### [MEDIUM — CVSS 5.9] F-004: `swapTarget` is owner-mutable but not witness-bound → owner can extract each user's signed slippage on the fuel leg
**Impact:** Medium (user-fund theft on the fuel slice, bounded by signed slippage; requires owner-key compromise/malice). **Confidence:** high (mechanism). **Mapping:** CWE-284 / CWE-829. **Found by:** Claude + Codex (router-LOW + swap-INFO + codex-HIGH, reconciled to MEDIUM).

**Instances:** `SwapBridgeRouter.sol:142-146` (instant, un-timelocked `setSwapTarget`); witness omits the target (`:52-56,167-180,325-341`); guards `:196,:199,:204`.

**Description.** The Permit2 witness binds `routeHash` but not *which* `swapTarget` executes the route, and the owner can swap the target at any instant with no timelock. The three guards bound a hostile target to exactly `(==fuelAmount in, ≥minFuelOutput out)` — so principal and the bridged token leg are untouchable — but not to *fair value*: a malicious target can return exactly `minFuelOutput` and pocket `(fair − minFuelOutput)`. Severity is held to Medium because it requires owner compromise and is capped at the per-tx slippage band of the fuel slice (~3%), never the principal. Reported because it's a missing safeguard affecting every fueled bridge, with a clean fix.

**Fix.** Add `address swapTarget` as a 12th witness field — any `setSwapTarget` then invalidates every outstanding signature, closing both this and the conceptual gap. Stronger: make `swapTarget` immutable or timelocked + 2-step.
**PoC sketch.** Foundry: malicious target that `transferFrom`s the full `fuelAmount`, returns exactly `minFuelOutput` FJ, keeps the rest; assert `bridgeWithFuel` succeeds and the target retains `fuelAmount − cost`.
**Effort:** hours (contract field + JS mirror) + redeploy.

---

### [MEDIUM — CVSS 5.3] F-005: exported `runSwapBridge` is fail-open for private-fuel invariants (library API; shipping faucet is safe)
**Impact:** Medium (stranded fuel / mis-routed gas for integrators of `@unleashed/bridge-core`). **Confidence:** moderate (Codex-only, verified). **Mapping:** CWE-20. **Found by:** Codex.

**Instances:** `packages/bridge-core/src/flows.ts:259` (`const fuelSecret = p.fuelSecret ?? Fr.random()`), `:276,:300` (`fuelRecipient` passed through unchecked); invariant documented only as a comment `:216-220`; faucet compensates at `packages/faucet/src/composables/useDeposit.ts:530-543,646-650`.

**Description.** On the private path, if a caller omits `fuelSecret`, the helper silently falls back to `Fr.random()` — which strands the Fee Juice forever (the PrivateFPC claimer must reconstruct `deriveBridgeSecret(salt, claimer)`; a random secret is unrecoverable). It also accepts any `fuelRecipient` without checking `isPrivate ⇒ fuelRecipient == PRIVATE_FPC_ADDRESS`, so gas can be deposited publicly to the wrong L2 address. The shipping faucet always derives and passes both correctly, so it is **not** affected — this is a library-API safety gap that bites a future/third-party caller.

**Fix.** In `runSwapBridge`, when `isPrivate`: require `claimer` + `bridgeSecretSalt`, derive `fuelRecipient = PRIVATE_FPC_ADDRESS` and `fuelSecret = deriveBridgeSecret(salt, claimer)` internally, and reject overrides; at minimum hard-fail on missing `fuelSecret` or non-FPC `fuelRecipient` before signing.
**Effort:** hours.

---

### [LOW — CVSS 3.1] F-006: `UniswapFuelSwap.swap()` is permissionless with caller-supplied `minOutput` → direct-call sandwich (self-harm/MEV)
**Impact:** Low (self-harm/MEV for a direct EOA caller; the router path is safe — it witness-binds `minFuelOutput`). **Confidence:** high. **Mapping:** CWE-668. **Found by:** Claude.
**Instances:** `UniswapFuelSwap.sol:88-115` (permissionless, only bound is the caller's `minOutput`). The "hookless pool" route rule blocks hooks, not price.
**Fix.** Restrict `swap()` to the router (preferred), or `require(minOutput > 0)` and document it as caller-bounded. **Effort:** hours.

---

### [LOW — CVSS 2.6] F-007: bearer-secret private claim (recipient omitted) — ✅ FIXED on the recipient-committed deployment (`bridge-permit2-recipient-commitment`)
**STATUS — FIXED (recipient-commitment landed).** `claim_private` now takes a `claim_salt` and re-derives the consumption secret from `(claim_salt, recipient)` in-circuit (`claim_secret` Noir lib ↔ TS `deriveTokenClaimSecret`, keystone-pinned both toolchains), so a leaked salt can only claim to the ORIGINALLY-BOUND recipient — a relayer can finish a claim, never redirect. Portal bytecode + content hashes unchanged (the salt is committed via the message's secret_hash, not the content hash). Requires a fresh L2 stack (the deployment migration — plan `bridge-permit2-recipient-commitment`). The **real driver was the new relayer capability**, not this Low-2.6 finding. The old bearer deployment retains bearer semantics for in-flight claims. Below is the original finding for the record.

**Impact:** Low today (accepted design; no on-chain leak path found). **Confidence:** high. **Mapping:** cross-chain/Aztec-specific. **Found by:** Claude + Codex.
**Instances:** `token_bridge/main.nr:104-122` (`claim_private` content hash omits recipient); `TokenPortal.sol:90-112` (private deposit carries only `Poseidon(secret)`).
**Description.** Whoever holds the private claim secret can claim to any recipient. Inherited verbatim from canonical Aztec; recipient-commitment is the documented end-state but legitimately deferred (it requires forking portal + bridge + redeploy + re-audit). It stays a finding because the only guard is off-chain custody: the secret never leaks on-chain (L1 carries only the hash; claim runs in private execution; the faucet seals it at rest). The one seam: `RecoveryHooks.onSecret(s)` hands the plaintext to the integrator (`flows.ts:46-64,263-268`) — any integrator who logs/stores it unsealed makes the deposit→claim window front-runnable.
**Fix.** Until recipient-commitment lands, document the integrator contract loudly: never persist/log the plaintext secret. **Effort:** recipient-commitment = weeks (deferred); doc note = minutes.

---

### [LOW — CVSS 2.0] F-008: `UniswapFuelSwap.sweep` lacks `nonReentrant` (the router's `sweep` has it)
**Impact:** Low (latent — no accounted state today). **Confidence:** high. **Mapping:** CWE-691. **Found by:** Claude.
**Instances:** `UniswapFuelSwap.sol:290-303` (no guard) vs `SwapBridgeRouter.sol:287` (guarded). **Fix.** Add the `nonReentrant` modifier for consistency. **Effort:** minutes.

---

### Informational
- **INFO-1 — `MintableERC20` permissionless mint + Permit2 allowance override** (`MintableERC20.sol:41-50`): every holder is treated as having granted canonical Permit2 infinite allowance, and `mint` is permissionless (capped per tx). Testnet-faucet-by-design and **not** a theft path (Permit2 still requires the holder's signature), but a **severe production footgun** if this pattern is copied to a value token. Cleared as non-exploit; flagged for any non-testnet token.
- **INFO-2 — L1 deposits are not gated by L2 pause** (`token_bridge/main.nr` pauses claim/exit, nothing pauses `depositToAztec*`): during an L2-paused incident, users can still deposit on L1; those funds sit unconsumed (no loss, recoverable on unpause) but the UI may not explain why. Add a frontend `is_paused` pre-check (note: the bridge has no public `is_paused` getter — clients can't cheaply read it).
- **INFO-3 — `deposit-testnet.ts` guesses the Inbox leaf index via `simulateContract`** (`:203-211`) where `flows.ts:104-111` already uses the correct event-based pattern; a concurrent deposit can hang the smoke script. Script-only.

---

## Findings NOT pursued (cleared with reasoning)

- **Permit2 replay / EIP-712 type confusion** — witness binds spender=router + chainId + verifyingContract=Permit2; 11 fields consistent across TYPEHASH/TYPE_STRING/`_hashBridgeWitness`/JS mirror; fork test covers nonce/expiry/tamper. (both models)
- **Malicious / owner-replaced swap target stealing principal** — `minFuelOutput` floor + FJ balance-delta + strict `consumed==fuelAmount` bound it to the signed trade; over-delivery only strands attacker-funded FJ residue. (both; Opus ran throwaway Foundry PoCs)
- **Weird `bridgeToken`** (fee-on-transfer/rebasing/reentrant) — reverts atomically at the consumption check; self-harm only. (both)
- **Native-ETH settlement reentrancy** — `swap()` nonReentrant, `unlockCallback` PoolManager-only, `receive()` inert, V4 reverts on unsettled deltas; `ethBridgeAmount` is the same variable as input/settle by construction. (both)
- **Minter-allowlist bypass / pause TOCTOU** — deploy authorizes only the bridge; `#[only_self]` blocks external callers; the enqueued pause-assert reverts the whole atomic tx, so `claim_private` is effectively paused. (both)
- **Withdraw double-consume / `_withCaller` front-run** — CEI order + canonical Outbox nullifier; recipient bound in the content hash → front-run is altruism/griefing, not theft. (Claude)
- **JS witness drift / weak secret / zero-slippage (faucet path)** — field order matches Solidity, bearer secret is `Fr.random()` (CSPRNG: `getRandomValues`/`randomBytes`), 3% slippage floor + `minFuelFj` gate, secret sealed at rest and never logged. (both)

## Cross-cutting observations

1. **Init/authority, not logic, is the weak axis.** Every serious finding (F-001, F-002, the F-004 owner power) is about *who can change configuration after deploy*, not about the swap/permit2/content-hash arithmetic — which is well-built. The remediation theme is the same everywhere: bind it (witness), guard it (init-once), or move it off a hot EOA (multisig/timelock) and freeze it after bootstrap.
2. **Verification exists but isn't wired.** The team wrote the right guards (content-hash keystone, witness pin, router invariant tests, `verify:l1`) — they just don't run in CI (F-003) and one only logs instead of asserting. The guards are dead weight until a `bridge-contracts.yml` gate executes them; this is the single highest-leverage, lowest-cost fix.
3. **The vendored "canonical" portal is a reference contract, not production-hardened.** F-001 stems from deploying Aztec's *example/test* `TokenPortal` verbatim. Any vendored upstream that's deployed as production infra needs the same scrutiny as first-party code — especially its initialization and admin surface.
4. **Testnet-shaped shortcuts must not graduate.** The permissionless `MintableERC20`, the infinite Permit2 allowance, the hot-EOA owners, and the live re-initializable portal are all reasonable for a testnet faucet but are exactly the things that turn into incidents if the same artifacts/patterns are promoted to a value-bearing deployment. Gate the promotion.
