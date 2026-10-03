# L1 portal + L1↔L2 content-hash boundary — red-team findings

**Auditor:** Claude (Opus 4.8) · **Cluster:** STRAND-funds / FORGE-message
**Scope:** OUR wiring/init/deploy of the vendored `TokenPortal`, the cross-chain content-hash equality, the L2 `TokenBridge`/`TokenMinterProxy` consume paths. NOT the canonical OZ/Aztec bodies.

**Files audited (full reads):**
- `packages/bridge-evm/upstream/TokenPortal.sol` (vendored canonical, 151 LOC)
- `packages/bridge-evm/script/DeployBridge.s.sol` (L1 fuel-pool seeder; does NOT touch the portal)
- `packages/bridge-core/scripts/deploy-bridge-testnet.ts` (the PERSISTENT testnet deploy — production-facing)
- `packages/bridge-core/scripts/deploy-sandbox.ts` (local sandbox deploy)
- `packages/bridge-core/scripts/verify-l1.ts`
- `packages/bridge-aztec/keystone/src/main.nr` + `packages/bridge-evm/test/ContentHash.t.sol` (the cross-toolchain equality pair)
- `packages/bridge-aztec/token_bridge/src/main.nr`, `packages/bridge-aztec/token_minter_proxy/src/main.nr`
- `packages/bridge-evm/src/SwapBridgeRouter.sol` (withdraw/consume context)
- `.github/workflows/*` (CI gate inventory)
- `packages/faucet/public/testnet-bridge.json` (LIVE deployment) + `packages/faucet/src/contracts/bridge-deployments.ts` (UI consumer)

**On-chain probe:** I queried the live Sepolia portal `0x9c41d1dd627ed53e25702590ab974d9dfa0c11ea` directly. It is currently initialized correctly but the init function carries no guard (details in F-1).

---

## SEVERITY SUMMARY

| # | Title | Severity | Confidence |
|---|---|---|---|
| F-1 | `TokenPortal.initialize` is permanently re-callable — anyone can repoint `underlying`/`registry`/`l2Bridge` on the LIVE portal | **CRITICAL** | High |
| F-2 | Deploy initializes the portal in a SEPARATE tx from deploy → multi-minute front-run / hijack window on a public chain | **HIGH** | High |
| F-3 | Cross-chain content-hash equality test (keystone `.nr` + `ContentHash.t.sol`) is NOT run in CI — drift is silent and strands funds | **HIGH** | High |
| F-4 | No Solidity/Noir test is wired to any runnable script or CI gate at all (whole bridge-evm + bridge-aztec) | **MEDIUM** | High |
| F-5 | Pause is not enforced on the L1 deposit; an L2-paused window strands in-flight deposits (liveness) | **LOW** | High |

**Worst:** F-1 — a live, unauthenticated re-initialization on a portal that real users are depositing into via the shipping faucet Bridge UI. Full fund-redirect + held-token-theft primitive.

---

## F-1 — `TokenPortal.initialize` is permanently re-callable (unprotected, no init guard) [CRITICAL]

**HOT-SPOT #1 VERDICT: CONFIRMED CRITICAL.**

### Trace
- **L1 sink:** `packages/bridge-evm/upstream/TokenPortal.sol:37-46` — `function initialize(address _registry, address _underlying, bytes32 _l2Bridge) external`. No `onlyOwner`, no `initializer` modifier, no `require(registry == address(0))` first-call guard, no `msg.sender` check. Grep for `require|onlyOwner|initializer|_initialized` across the file returns **nothing** in `initialize`. It is plain `external` and idempotently overwrites all four storage slots plus the derived `rollup`/`outbox`/`inbox`/`rollupVersion`.
- **L1 deploy (production):** `packages/bridge-core/scripts/deploy-bridge-testnet.ts:113` deploys the portal with `args=[]` (constructor takes none → storage all-zero), then `:191` calls `initialize([registry, usdc, bridge])` in a later, separate tx.
- **Live state:** `packages/faucet/public/testnet-bridge.json` (git-tracked) pins `l1.portal = 0x9c41d1dd627ed53e25702590ab974d9dfa0c11ea`. Querying Sepolia: `underlying()=0x…a40a2fe1…2c68` (the AZLO USDC), `l2Bridge()=0x0e31…748e` (the AZLO bridge), `registry()=0x…a0bfb1b4…c6ba`. So it is *currently* initialized correctly — but nothing stops a second call.
- **UI exposure:** `packages/faucet/src/contracts/bridge-deployments.ts:18` exports `L1_PORTAL` from that JSON; consumed by `useDeposit.ts`, `useWithdraw.ts`, `BridgeForm.vue`, `BridgeView.vue`. Real users deposit into this portal **now**.

### Forge/strand scenario (theft + redirect, both)
The attacker deploys a tiny fake registry whose `getCanonicalRollup()` returns an attacker-controlled "rollup" contract exposing `getOutbox()`, `getInbox()`, `getVersion()`. Then:

```
attacker.initialize(fakeRegistry, attackerToken, attackerL2Bridge)
```

Because `initialize` re-derives `rollup = registry.getCanonicalRollup()` from the **passed** registry (`:42`), the attacker controls the entire messaging stack the portal trusts, plus:

1. **Held-token theft / strand.** `underlying` becomes `attackerToken`. Every token already held by the portal (tokens deposited but whose L2 message hasn't been consumed yet — always non-zero in a live bridge) is now referenced by the *wrong* ERC-20. Worse, the attacker repoints `underlying` to a token they control; subsequent `withdraw` (`:148 underlying.safeTransfer`) pays out the attacker's token, and the genuine AZLO held in the portal is orphaned (no code path references it anymore → permanent strand). The real AZLO sits at the portal address with no function able to move it.
2. **Deposit redirect / message forgery.** With `inbox` pointing at an attacker contract, every future `depositToAztecPublic/Private` (`:74`,`:106 inbox.sendL2Message`) sends the L1→L2 message into the attacker's fake inbox instead of the canonical Aztec Inbox — the user's tokens are pulled (`safeTransferFrom`) and the real L2 mint never happens. Funds enter a portal that no longer talks to the real rollup.
3. **`l2Bridge` swap.** Content-hash actor becomes attacker's L2 bridge; even messages that did reach a real inbox would target the wrong consumer.

All three are reachable by **any EOA**, no privilege, one tx, against the contract real users are funding.

### Preconditions
- The deployed portal is the vendored canonical one (confirmed — `deploy-bridge-testnet.ts:113` uses `@aztec/l1-artifacts` `TokenPortalBytecode`).
- None else. `initialize` has zero gating.

### Why guards fail
There are no guards. The canonical Aztec `TokenPortal` is a *reference/test* portal (`l1-contracts/test/portals/TokenPortal.sol`, per `verify-l1.ts:30`) — it was never meant to be initialized in a separate, permissionless tx on a public chain. Unleashed vendored it verbatim and deploys+inits it as production infra. The vendored body is keccak-pinned (`verify-l1.ts:51-62`), so we cannot patch the body without breaking the pin — the fix must wrap it.

### Smallest fix (ranked)
1. **Atomic init via a factory/wrapper.** Deploy a thin `TokenPortalFactory` that, in its constructor (or a single `create` call), deploys the portal and calls `initialize` in the **same tx**, then there is no observable uninitialized window. This does not stop a *second* init though — so combine with (2).
2. **Wrap with an init-once guard.** Since the body is pinned and can't be edited, deploy an `InitGuardedTokenPortal` that inherits/forwards and adds `bool private _inited; function initialize(...) external { require(!_inited); _inited = true; super-or-inline; }`. But inheriting the pinned artifact bytecode is not possible — practically this means **un-pinning and forking** the portal to add `if (address(registry) != address(0)) revert AlreadyInitialized();` as the first line of `initialize`, then re-pinning the fork. This is the real fix.
3. **Front-run-proof deploy + immediate self-init in the same broadcast bundle**, plus a deploy-time post-check that re-reading `registry()` equals the expected value and `l2Bridge()` equals the expected bridge — and treat the residual re-init capability as an accepted risk documented loudly. (Weakest; leaves the permanent re-init primitive live.)

The minimal *correct* fix is (2): fork the vendored portal to add a one-line already-initialized check, re-run the keccak pin against the fork, and redeploy. Everything currently deployed (`0x9c41…11ea`) must be migrated — it is unfixable in place.

### PoC (Foundry)
`packages/bridge-evm/test/PortalReinit.t.sol`:
```solidity
// 1. Deploy portal from vendored bytecode (or import the contract).
// 2. portal.initialize(realRegistry, realUSDC, realBridge);  // legit
// 3. Deploy FakeRegistry { function getCanonicalRollup() returns(address){ return address(fakeRollup);} }
//    FakeRollup { getOutbox/getInbox => attacker addrs; getVersion => 1; }
// 4. vm.prank(attacker); portal.initialize(address(fakeRegistry), attackerToken, attackerBridge);
// 5. assertEq(address(portal.underlying()), attackerToken);   // PASSES pre-fix == vuln proven
//    assertEq(address(portal.inbox()), attackerInbox);
// Post-fix: step 4 reverts AlreadyInitialized → test asserts the revert.
```

**SWC/CWE:** SWC-118 (Incorrect Constructor / uninitialized), CWE-665 (Improper Initialization), CWE-284 (Improper Access Control).

---

## F-2 — Portal init happens in a SEPARATE tx from deploy → public front-run / hijack window [HIGH]

### Trace
- `deploy-bridge-testnet.ts`: portal deployed at `:113`; between `:117` and `:188` the script does the **entire L2 deploy with real proofs** (account deploy `~minutes`, three contract deploys, `set_token`, `set_minter`); only at `:191` does it `initialize` the portal. The header comment says "real proofs → ~8 min." So on Sepolia the portal exists deployed-but-uninitialized for **multiple minutes**.
- `deploy-sandbox.ts` has the identical shape: deploy at `:105`, init at `:173`, with L2 deploys in between.

### Scenario
During that window any observer of the Sepolia mempool/chain sees the freshly deployed portal with zero storage. They call `initialize(attackerRegistry, attackerToken, attackerBridge)` first. The deployer's later `initialize` at `:191` **succeeds too** (no guard — F-1) and overwrites it back, so for the deployer the deploy *looks* fine. But:
- If the attacker init lands *after* the deployer's (trivial — they watch for the deployer's init tx and back-run it), the portal ends in the attacker's configuration and the deploy script has already exited successfully. The operator believes the portal is correctly wired (the script printed "portal initialized").
- Even without F-1's permanence, the separate-tx pattern means the "correct" final state depends on tx ordering the deployer does not control.

This is really the temporal half of F-1; rated separately because the *fix is different* (atomic deploy+init closes the window) and because even a properly-guarded portal would still be hijackable in this window if the guard were "first-writer-wins" rather than "deployer-only."

### Preconditions
Public chain (Sepolia/mainnet), observable mempool. On the sandbox (anvil, single operator) it's not exploitable.

### Fix
Deploy + initialize atomically (factory constructor, or a `multicall`/single-bundle). Combined with F-1's guard, this fully closes both the window and the permanence. Also: after init, the script should **read back** `portal.registry()/underlying()/l2Bridge()` and assert they equal the intended values before writing `testnet-bridge.json` — neither deploy script does this today.

**SWC/CWE:** SWC-114 (Transaction Order Dependence), CWE-665, CWE-362 (Race Condition).

---

## F-3 — Cross-chain content-hash equality is NEVER checked in CI → silent drift strands funds [HIGH]

**HOT-SPOT #8 VERDICT: equality currently HOLDS byte-for-byte, but is UNGUARDED in CI.**

### What I verified (the equality itself is fine — today)
The L1 selectors and the Noir vectors match exactly:

| Vector | L1 selector (`TokenPortal.sol`) | Keystone `.nr` literal | `ContentHash.t.sol` literal | Match |
|---|---|---|---|---|
| public | `mint_to_public(bytes32,uint256)` (`:68`), args `(to,amount)` | `0x00fb464b…0e140dcc` (`keystone:20`) | `0x00fb464b…0e140dcc` (`:24`) | ✅ identical |
| private | `mint_to_private(uint256)` (`:100`), arg `(amount)` | `0x00009b1e…a2c63954` (`keystone:26`) | `0x00009b1e…a2c63954` (`:25`) | ✅ identical |
| withdraw | `withdraw(address,uint256,address)` (`:141`), args `(recipient,amount,caller)` | `0x00ac390e…10a60775` (`keystone:33`) | `0x00ac390e…10a60775` (`:26`) | ✅ identical |

Arg order, selectors, and the `sha256ToField` top-byte truncation (leading `0x00`) all line up. The L2 `TokenBridge` uses the same `token_portal_content_hash_lib` (`token_bridge/main.nr:22-24`) the keystone proves, and both lib + keystone pin to the same upstream tag (`v4.2.0-aztecnr-rc.2`, per all three `Nargo.toml`). **No drift exists right now.**

### The finding: the guard is never executed
- Grep of `.github/` for `forge test|nargo|\.t\.sol|content.?hash|keystone|bridge-evm|bridge-aztec` returns **only** the `setup-aztec` composite action (which installs Foundry/Aztec CLI for the *network-e2e against a remote node* — `setup-aztec/action.yml`). No workflow ever runs `forge test` or `nargo test`.
- `_lint-and-typecheck.yml` (the `Quality / Status` required gate) runs Biome + `vue-tsc` + `bun audit` only.
- The keystone header literally says "Run: nargo test (with the rc.2 nargo)" and `ContentHash.t.sol` says "the matching Noir assertion lives in bridge-aztec" — but nothing automates either. Both are run-by-hand-or-never.

### Why this is HIGH not informational
The two tests are *pinned literals*, not live recomputations of each other. If a future Aztec bump changes `token_portal_content_hash_lib` (selector string, hashing, field packing) **and** someone bumps the `Nargo.toml` tag, the Noir side changes silently. The keystone `.nr` literal would then fail — but only if someone runs `nargo test`, which CI never does. Likewise an edit to the L1 selector in a forked portal would slip past `ContentHash.t.sol` since `forge test` never runs. Result: deposits emit an L1 content hash the L2 `claim_*` can't reconstruct → `consume_l1_to_l2_message` reverts forever → **every deposit strands** (tokens pulled on L1, unmintable on L2). This is exactly the strand boundary the keystone was written to guard, with the guard disconnected from the pipeline.

### Fix
Add a `bridge-contracts.yml` PR workflow (paths-filtered to `packages/bridge-evm/**` + `packages/bridge-aztec/**`) that runs `forge test` (at least `ContentHash.t.sol` + `WitnessHash.t.sol`) **and** `nargo test` (keystone + the contract `#[test]`s) on every change to either tree. Make it a required check. The two pinned-literal tests only have value if they run; today they are dead weight.

**SWC/CWE:** cross-chain / Aztec-specific (message content-hash mismatch); adjacent CWE-1059 (insufficient test/verification automation).

---

## F-4 — No Solidity/Noir test is wired to any script or gate (whole bridge contract surface) [MEDIUM]

### Trace
- `packages/bridge-evm/package.json`: no `test` script exists. The eight `test/*.t.sol` files (`SwapBridgeRouter.t.sol`, `RouteValidation.t.sol`, `ContentHash.t.sol`, the Permit2 fork test, …) are runnable only by a manual `forge test`.
- `packages/bridge-aztec`: no JS `package.json`/test script; Noir tests run only via `nargo test`.
- Only `bridge-core` has `"test": "vitest run"` — and the `bun run audit:vue` / `Quality / Status` gates target the faucet, not these.

Superset of F-3: even the router's *own* invariants (the three fuel-consumed guards at `SwapBridgeRouter.sol:196-204`, the witness typehash/type-string consistency, route hashing) have Foundry tests that nothing runs automatically. A refactor that breaks the EIP-712 type string (`:53` vs `:56`) — a DoS-or-type-confusion class — would ship green.

### Fix
Same `bridge-contracts.yml` as F-3, broadened to run the full `forge test` + `nargo test` suites. Add `"test:contracts": "forge test"` to `bridge-evm` and a `nargo test` script to `bridge-aztec` so they're locally discoverable too.

**SWC/CWE:** CWE-1059 (insufficient verification), process gap.

---

## F-5 — Pause does not gate L1 deposits; an L2-paused window strands in-flight deposits [LOW]

### Trace + analysis (this is a clear, not a bug-in-disguise)
- `claim_private` (`token_bridge/main.nr:111`) does `self.enqueue_self._assert_not_paused()` then `consume_l1_to_l2_message` (`:115`). The pause check is **enqueued** (runs in the public phase after the private exec), whereas `claim_public` (`:94`) and `exit_to_l1_public` (`:127`) check `is_paused` **inline**.
- I checked whether the enqueued check is bypassable: in Aztec a reverting enqueued public call reverts the whole atomic tx, so a paused bridge *does* roll back the private `consume`. The pause is effective for `claim_private`. **Not a vuln.** (Worth a one-line note that the public/private asymmetry — inline vs enqueued — is intentional and load-bearing; if a future refactor moves `consume` to depend on a value the enqueued check would have rejected, re-audit.)
- The real liveness note: **nothing pauses the L1 `depositToAztec*`.** If an operator pauses the L2 bridge (`set_paused(true)`) for an incident, users can still deposit on L1 (tokens pulled into the portal, message queued), but `claim_*` reverts on the pause. Those deposits sit unconsumed until unpause. No loss (the message is still consumable later), but funds are temporarily stranded and the UI may not surface why.

### Why LOW
No theft, no permanent strand (unpause resolves it), and the L1 portal is canonical (pause-on-L1 isn't its design). It's a UX/liveness sharp edge worth a frontend guard (check `is_paused` before letting a user deposit) rather than a contract change.

**SWC/CWE:** cross-chain liveness / availability; CWE-665-adjacent (state-coupling between chains).

---

## Items checked and CLEARED (no finding)

- **`withdraw` double-consume / reentrancy (`TokenPortal.sol:126-149`).** Order is `outbox.consume` (`:146`, nullifies) **before** `underlying.safeTransfer` (`:148`) — effect-before-interaction. Double-consume is blocked by the canonical Outbox nullifier (out of scope, trusted). `underlying` is fixed at init, so the transfer target isn't attacker-chosen (absent F-1). No reentry primitive in our wiring. **Safe** (modulo F-1 repointing `underlying`).
- **`withdraw` `_withCaller` front-running.** The recipient is bound in the content hash (`:141 withdraw(address,uint256,address)`, first arg `_recipient`). When L2 sets `caller=0` (the sandbox uses `EthAddress.ZERO`), anyone may submit `withdraw(_withCaller=false)`, but the funds go to the **L2-chosen `_recipient`** regardless of who submits. A front-runner can only pay the gas to deliver someone else's funds to the correct address — griefing/altruism, not theft. When L2 sets a specific `caller_on_l1`, only that caller can consume. **Safe.**
- **Deposit `secretHash` gating.** `depositToAztec*` pass `_secretHash` straight into `inbox.sendL2Message` (`:74`,`:106`); consumption requires the preimage `secret` on L2 (`claim_*` `consume_l1_to_l2_message`). A deposit with a secret hash whose preimage is lost is a self-strand (user error), not a protocol bug. The bearer-secret-omits-recipient private-claim issue is an accepted design item and belongs to another cluster's #3 — not re-raised here.
- **Content-hash equality byte-for-byte** — verified identical across both toolchains (see F-3 table). The *equality* is correct; only its CI enforcement is missing.

---

## Cross-references for the reduce step
- F-1/F-2 are the same root (separate-tx, unguarded init) split by fix surface; merge if the reduce prefers one CRITICAL.
- F-3/F-4 share one fix (a `bridge-contracts.yml` gate running `forge test` + `nargo test`); F-3 is the high-stakes subset (strand boundary), F-4 the general gap.
- F-1 interacts with the cluster's swap findings: a repointed `underlying` also poisons `SwapBridgeRouter`'s token-portal deposit path, but the router reads `p.tokenPortal` from the witness, so the blast radius there is whatever the user signed.
