# L2 / Noir red-team — TokenBridge + TokenMinterProxy

**Auditor:** Claude (Opus 4.8), adversarial pass · **Run:** bridge-redteam
**Scope:** `packages/bridge-aztec/token_bridge/src/{main,config}.nr`, `packages/bridge-aztec/token_minter_proxy/src/main.nr`, with the strand-boundary verified against the pinned upstream content-hash lib and the deploy/wire scripts.
**Toolchain pin:** aztec-nr `v4.2.0-aztecnr-rc.2`. Upstream sources read from the local nargo cache at that exact tag.

---

## Execution-model facts established first (load-bearing for every finding)

These were verified against aztec-nr source, not assumed. Every pause/mint claim below rests on them.

1. **`consume_l1_to_l2_message` runs in the frame it is called from and emits the nullifier *there*.**
   - In a `#[external("public")]` fn it is `PublicContext::consume_l1_to_l2_message` (`public_context.nr:233-251`): checks `nullifier_exists_unsafe`, checks `l1_to_l2_msg_exists`, then `push_nullifier`. All inline, public, synchronous.
   - In a `#[external("private")]` fn it is `PrivateContext::consume_l1_to_l2_message` (`private_context.nr:839-853`) → `process_l1_to_l2_message` (`messaging.nr:8-39`) → `push_nullifier`. The nullifier is computed and pushed **during private proving**, on the user's device, before any enqueued public call runs.

2. **The L1→L2 nullifier binds `{portal, chain_id, recipient=bridge_address, version, content, secret_hash, leaf_index}` and the secret preimage — NOT the claim recipient.** `compute_l1_to_l2_message_hash(portal, chain_id, contract_address /*=bridge*/, version, content, secret_hash, leaf_index)` then `compute_l1_to_l2_message_nullifier(message_hash, secret)` (`messaging.nr:19-38`). For private claims `content = get_mint_to_private_content_hash(amount)` which is `sha256(selector("mint_to_private(uint256)") || amount)` — **no recipient byte anywhere** (upstream `token_portal_content_hash_lib/src/lib.nr:30-48`). Consequence: the nullifier stops the *same leaf* being consumed twice, but the AztecAddress passed as `recipient` to `claim_private` is a free parameter that never enters the hash.

3. **Enqueued public calls execute in enqueue order, after all private execution, and the whole tx is atomic.** `enqueue` pushes a `Counted<PublicCallRequest>` onto an ordered `BoundedVec` with a monotonic counter (`private_context.nr:1282,1296`; `contract_self_private.nr:285-287`). The proposer runs them in counter order. Any revert in any enqueued public call reverts the entire tx, including the private-side nullifier insertion from fact (1). There is no partial commit. (`contract_self_private.nr:270-287` docstring: "the called function ... Side effects ... are included in this transaction".)

4. **`self.call(...)` from private = a nested *private* call (`contract_self_private.nr:241-246`).** So `claim_private`'s `self.call(TokenMinterProxy::...mint_to_private(...))` is a private→private call; the proxy's `mint_to_private` then itself does `self.enqueue_self.assert_minter(sender)` (proxy `main.nr:84-88`), enqueuing ITS OWN public assert. Net effect on a private claim: two public asserts get enqueued (`bridge._assert_not_paused`, then `proxy.assert_minter`) plus the public token mint, all in one atomic tx.

5. **`#[only_self]` enforces `msg_sender == self` on the public side.** `_assert_not_paused` and `assert_minter` carry `#[only_self]`; they are only reachable from the same contract's enqueued/`call_self` path, not by an external caller. (Confirmed by the macro generation in `internals_functions_generation/internal.nr` and the `enqueue_self` plumbing.)

6. **`PublicImmutable::initialize` is genuinely once-only.** It pushes an initialization nullifier (`public_immutable.nr:149-159`); a second init re-emits the same nullifier → tx reverts. `read()` asserts initialized (`:179-185`).

---

## Findings

### F-L2-01 — `claim_private` is a bearer claim: the secret holder mints to an attacker-chosen recipient (recipient not bound in the content hash)

- **Impact factors / exploitability:** Theft of in-flight bridged funds *iff* the bearer secret leaks during the deposit→claim window. No protocol bug — the omission is inherited verbatim from canonical Aztec. Whether it is **exploitable** or **accepted-risk** turns entirely on secret custody (analyzed below). With the current frontend, it is **accepted-risk**; it becomes **exploitable** only under a secret-leak that the current code does not introduce.
- **Confidence:** High (source-confirmed at both the content-hash lib and the nullifier composition).
- **Class:** Aztec-specific (bearer L1→L2 message; "knowledge of secret = authority to consume"). Nearest CWE: CWE-294 (Authentication Bypass by Capture-replay) / CWE-862 (Missing Authorization) — the recipient is unauthorized but accepted.
- **Trace (source → sink):**
  - L1 deposit emits only the *hash*: `TokenPortal.depositToAztecPrivate(amount, secretHashForL2MessageConsumption)` → `contentHash = sha256ToField(mint_to_private(uint256), amount)`; `inbox.sendL2Message(actor=l2Bridge, contentHash, secretHash)`; `emit DepositToAztecPrivate(amount, secretHash, key, index)` (`upstream/TokenPortal.sol:90-109`). The secret preimage never crosses L1.
  - L2 sink: `token_bridge/src/main.nr:104-122` `claim_private(recipient, amount, secret, leaf)` → `content_hash = get_mint_to_private_content_hash(amount)` (recipient absent) → `consume_l1_to_l2_message(content_hash, secret, portal, leaf)` → `proxy.mint_to_private(recipient, amount)`.
  - Nullifier excludes recipient: `messaging.nr:19-38` (fact #2).
- **Exploit scenario (the exploitable case):** Alice deposits privately; her per-deposit secret `s` leaks (see leak-vector map). Mallory front-runs Alice's claim with `claim_private(MALLORY_ADDR, amount, s, leaf)`. The nullifier is computed from `{..., content(amount), secret_hash(s), leaf}` — independent of recipient — so Mallory's tx consumes the leaf and mints `amount` to Mallory. Alice's later claim hits "L1-to-L2 message is already nullified". One-shot theft, no slippage bound, full amount.
- **Preconditions:** (a) secret `s` is known to the attacker before Alice claims; (b) the leaf is synced to L2 but not yet consumed (the deposit→claim window — minutes on testnet, can be long if Alice's PXE lags, per the 200×3s retry loop in `flows.ts:115-125`). Without (a), unexploitable.
- **Leak-vector map (what makes it merely accepted-risk today):**
  - **L1 calldata / events:** carry `secretHash = Poseidon(s)` only, never `s` (`TokenPortal.sol:90,100,106,109`; `flows.ts:67` builds `depositArgs = [amount, secretHash]`). `consume_l1_to_l2_message` requires the *preimage* `s`, and Poseidon is preimage-resistant. An L1 mempool/chain observer **cannot** derive `s`. CLEAN.
  - **L2 claim calldata:** `claim_private` runs in **private** execution; `secret` is a private witness, never published. The enqueued public calls (`_assert_not_paused`, `assert_minter`, `mint_to_public` inside the token) carry only `recipient`/`amount`/`bool` — not the secret. So even watching the consuming tx does not reveal `s` to a future claimant (and by then the leaf is nullified anyway). CLEAN.
  - **Frontend persistence:** for private deposits the journal record stores `secret: undefined` (`useDeposit.ts:568`); the plaintext secret is held in memory only and sealed at rest under an L1-signature-derived key (`useDeposit.ts:604-613`, `sealDepositRecord`). It is NOT written to `localStorage` in cleartext. CLEAN at rest.
  - **The one real in-process exposure:** `RecoveryHooks.onSecret({ secretHex, ... })` fires the *plaintext* secret to the app-supplied callback **before** the irreversible L1 deposit (`flows.ts:46-64`). This is by design (lose-the-preimage-strands-funds), and in `useDeposit.ts` it is consumed to seal, not to log. But it is the seam an integrator can foot-gun: any code that tees `secretHex` into a log line, analytics, error report, or unsealed store turns F-L2-01 from accepted-risk into exploitable. This is the thing to watch, not a contract bug.
- **Why the guard "fails" (i.e., why it's accepted-risk, not safe):** there is no guard. The design choice is that the deposit content commits to `amount` only; authority is bearer. The mitigation lives entirely off-chain (secret custody + seal). The contract cannot tell Mallory from Alice. Recipient-commitment (`hash(recipient, salt)` into the deposit content hash) is the chosen end-state but is **deferred** because the L1 portal is the *canonical, keccak-pinned* Aztec `TokenPortal` and binding the recipient requires forking the portal + the L2 bridge + redeploy + re-audit. That is a legitimate deferral, not an oversight — but it is a deferral, so this stays a live finding rather than "won't fix / safe".
- **Smallest fix (when un-deferred):** fork the portal's `depositToAztecPrivate` to hash `mint_to_private(bytes32 recipientCommitment, uint256 amount)` where `recipientCommitment = pedersen(recipient, salt)`, and have `claim_private` recompute the commitment from its `recipient`+`salt` args and feed it into `get_mint_to_private_content_hash`. Until then: the off-chain seal is the control; keep `secretHex` out of every logging/persistence sink and document the `onSecret` foot-gun in `RecoveryHooks`.
- **PoC test idea (TXE, sandbox needed):** in a TXE test, deposit privately as Alice (or simulate an L1→L2 message with `content = get_mint_to_private_content_hash(amount)` and a known secret), then call `claim_private(bob, amount, secret, leaf)` from Bob's context and assert Bob's *private* balance increases by `amount` while Alice never receives it; assert Alice's subsequent `claim_private(alice, amount, secret, leaf)` reverts with "already nullified". Demonstrates recipient is unbound. A pure-Noir `#[test]` can't exercise message consumption (needs the L1→L2 tree), so this is TXE-only.

---

### F-L2-02 — `TokenMinterProxy` minter set is an uncapped, un-timelocked, multi-minter allowlist; a compromised proxy owner is unlimited mint of the bridged token

- **Impact factors / exploitability:** Catastrophic if the proxy owner key is compromised — `set_minter(attacker, true)` then `mint_to_public(attacker, 2^128-1)` mints the entire token supply to the attacker, on L1-bridged collateral that does not exist. The token behind the proxy is the same one the faucet Dripper mints, so blast radius is the whole L2 token, not just bridged balances. This is centralization risk, and per the run's negative list, owner-key-compromise IS a finding *when it reveals a missing safeguard a non-malicious deployment should have* — here, several are missing.
- **Confidence:** High.
- **Class:** SWC-105 (Unprotected critical function is gated, but the gate is a single hot key) / CWE-269 (Improper Privilege Management). Design-level (missing defense-in-depth), not a code defect.
- **Trace:** `token_minter_proxy/src/main.nr` — `set_minter(minter, allowed)` gated only by `owner == msg_sender` (`:54-59`); `mint_to_public` (`:67-73`) / `mint_to_private` (`:83-89`) gated only by `can_mint[msg_sender]`. No per-minter cap, no aggregate supply cap, no rate limit, no timelock on `set_minter`, no "single canonical minter" invariant, no event/nullifier trail beyond the public state write. `amount: u128` so a single mint can be up to `2^128 - 1`.
- **Deploy reality (confirms intended authorization is bridge-only):** all three deploy paths authorize exactly the bridge — `proxy.set_token(token); proxy.set_minter(bridge.address, true)` (`bridge-core/scripts/deploy-sandbox.ts:166-167`, `deploy-bridge-testnet.ts:185-186`, `deposit-testnet.ts:170-171`). But the faucet Dripper is also expected to be a minter (per `bridge-aztec/README.md` — "so the faucet Dripper AND the bridge can mint the same token"), so the allowlist legitimately has ≥2 entries. The owner can add an (N+1)th at will.
- **Blast radius of a compromised proxy owner:** total. `set_minter(self, true)` → mint arbitrary `amount` to any recipient, publicly or privately. Because there is no supply cap and no timelock, the theft is atomic and unobservable-in-advance (no pending-change window for monitors to react to). The bridge's own pause (`is_paused`) does **not** protect the token — pause lives on `TokenBridge`, not on `TokenMinterProxy`; a malicious minter calls `mint_to_public` on the proxy directly and never touches the paused bridge.
- **Why guards fail:** the only guard is "is the caller an allowlisted minter / the owner". It is a binary, hot-key authority with no quantitative or temporal bound. A non-malicious production deployment of an unlimited-mint authority should have at least one of: (a) per-minter or global supply cap, (b) timelock on `set_minter` so a compromise is observable before it lands, (c) a multisig/governance owner rather than a single EOA-equivalent.
- **Smallest fix:** add a timelock (two-step `propose_minter` → `apply_minter` after a delay) on `set_minter`, OR a global mint cap checked in `mint_to_public`/`mint_to_private`. Minimum viable: make `owner` a multisig and emit an event on every `set_minter` so the change is monitorable. (For the bridge specifically, a per-minter allowance ceiling that the bridge can never exceed would bound even a bridge bug.)
- **PoC test idea (TXE):** deploy proxy+token, `set_minter(attacker, true)` from owner, then `mint_to_public(attacker, u128::MAX)` from attacker and assert the attacker's public balance == `u128::MAX` (or the token's max). Demonstrates uncapped mint reachable from any allowlisted address. Pure `#[test]` insufficient (needs cross-contract `self.call` into the token).

---

### F-L2-03 — Pause TOCTOU across the private→public boundary: `claim_private`/`exit_to_l1_private` enqueue the pause assertion rather than reading it inline — analyzed as SAFE-by-atomicity, with one residual ordering caveat

- **Verdict:** Not exploitable for fund theft / pause bypass. The enqueue pattern is sound because of tx atomicity (fact #3). Documented in full because the asymmetry with `claim_public` is real and is exactly the kind of thing that *looks* like a TOCTOU.
- **Confidence:** High that no claim/exit slips through while paused; Moderate on the one residual (ordering vs the message-nullifier, below) being merely a gas/UX nit rather than a vuln.
- **Class:** Would-be SWC-114 (TOCTOU / transaction-ordering) — assessed and killed.
- **The asymmetry (real):**
  - `claim_public` (`main.nr:92-100`) and `exit_to_l1_public` (`:125-134`) read `is_paused` **inline** at the top, in the same public frame as `consume_l1_to_l2_message`/`message_portal` and the mint/burn. Pure source-order public execution: paused ⇒ assert fails ⇒ whole call reverts before consume. Trivially safe.
  - `claim_private` (`:104-122`) and `exit_to_l1_private` (`:137-146`) call `self.enqueue_self._assert_not_paused()` (`#[only_self]`, `main.nr:85-89`). The pause read is deferred to public execution by the proposer; meanwhile `consume_l1_to_l2_message` pushes the nullifier during *private* proving (fact #1).
- **Why it's safe anyway:** the tx is atomic (fact #3). Sequence for a private claim submitted while paused:
  1. Private proving: nullifier for the L1→L2 leaf is computed + staged.
  2. Public execution (proposer), in enqueue order: `bridge._assert_not_paused()` runs **first** (it's enqueued before the nested mint's `assert_minter` and before the token mint — `claim_private` calls `enqueue_self._assert_not_paused()` as its first statement, line 111). If paused, it `assert`s false → reverts.
  3. The revert rolls back the **entire** tx, including the staged nullifier. The leaf is NOT consumed; no tokens mint. Net: the claim simply fails while paused, exactly like the public path.
  There is no window where the message is consumed but the mint is skipped, nor where the mint lands but pause is ignored — atomicity collapses the TOCTOU. An attacker cannot "race" the pause: pause is set by `set_paused` in a *separate* public tx; by the time the proposer executes the claim's enqueued `_assert_not_paused`, it reads whatever `is_paused` is at execution time. If pause landed first, the claim reverts; if the claim's block executes first, it was never paused at execution. Standard single-threaded public-state semantics; no interleaving within a tx.
- **Enqueue-ordering soundness:** confirmed. `_assert_not_paused` is enqueued as statement 1 of `claim_private` (counter k). The nested `proxy.mint_to_private` is a private call that enqueues `assert_minter` (counter k+1) and the token mint (counter ≥k+2). So at public-execution time the order is: pause-check → minter-check → mint. A paused bridge or a deauthorized bridge both short-circuit before the mint. Correct.
- **Residual caveat (NOT a vuln, flagged for completeness):** because the nullifier is staged in private *before* the enqueued pause check runs, a claim submitted while paused still does the full private proving work and only fails at public execution — wasted proving + a failed tx for the user, versus a clean early client-side reject. Also, an `is_paused` that flips between a user's private proving and the proposer's public execution is resolved at execution time (correct), but the UX is "your proof succeeded, your tx still reverted." This is inherent to Aztec's private→public model, costs only gas/UX, and is not a security issue. No fix required; if a cleaner failure is wanted, the app can `enqueue_view` the pause read or have the client check `get_config_public`/an `is_paused` getter before proving. (Note: there is currently **no** public getter for `is_paused` — only `get_config*` — so a client can't cheaply pre-check pause; minor.)
- **PoC test idea (TXE):** pause the bridge, submit `claim_private` for a valid synced leaf, assert the tx reverts with "Bridge is paused" AND that the leaf's nullifier is NOT present afterward (i.e. a subsequent unpaused `claim_private` for the same leaf succeeds). Demonstrates atomic rollback — the message survives the paused attempt.

---

### F-L2-04 — `exit_to_l1_*` burns `self.msg_sender()` under an authwit nonce — cannot burn a third party's tokens (SAFE); plus a no-op-vs-revert nit on `authwit_nonce`

- **Verdict:** Safe. You cannot burn someone else's balance via the bridge.
- **Confidence:** High.
- **Trace:** `exit_to_l1_public` (`main.nr:133`) / `exit_to_l1_private` (`:145`) call `proxy.burn_{public,private}(self.msg_sender(), amount, authwit_nonce)`. The proxy forwards to `token.burn_{public,private}(user_address, amount, authwit_nonce)` (`token_minter_proxy/main.nr:76-81,91-97`) where `user_address = msg_sender` is set by the *bridge*, not attacker-controlled. The Wonderland `token` contract requires the burn to be authorized by `user_address` — either `user_address == effective msg_sender` or a valid AuthWit. Since the bridge passes the original caller as `user_address`, an attacker calling `exit_to_l1_*` can only burn **their own** tokens (and only their own withdraw message is created). They cannot pass `victim` as the burn target — the parameter is hard-wired to `self.msg_sender()`.
- **Why safe:** the burn target is not a function parameter of `exit_to_l1_*`; it is fixed to the caller. The `authwit_nonce` only matters for the caller authorizing the *bridge→proxy→token* call chain against their own balance. No path lets caller A burn caller B.
- **Nit (not a finding):** `exit_to_l1_*` never asserts `authwit_nonce == 0` for the direct-call case nor validates it; it is passed straight through to the token, which is the correct layer to enforce it. No action.
- **PoC (negative) test idea (TXE):** as attacker, call `exit_to_l1_public(attackerEthAddr, amount, 0, 0)` while holding zero token balance but with `victim` having a balance; assert it reverts (insufficient balance for `msg_sender=attacker`), and that no withdraw message debiting `victim` is created. Confirms the burn is bound to the caller.

---

### F-L2-05 — `claim_*` is callable by anyone (no `msg_sender` gate) — intended for bearer claims; double-spend / replay correctly prevented by the message nullifier (SAFE)

- **Verdict:** Safe (and necessarily permissionless for the bearer model). Double-consume is blocked.
- **Confidence:** High.
- **Trace:** Neither `claim_public` nor `claim_private` restricts `msg_sender` — by design, the L1→L2 message + secret are the authority. Replay protection is the nullifier: `consume_l1_to_l2_message` asserts `!nullifier_exists_unsafe(nullifier)` then `push_nullifier` (`public_context.nr:247-250`; private path `messaging.nr:38` + `private_context.nr:852`). The nullifier is deterministic in `{message_hash, secret}`, so the *same leaf* can be consumed exactly once. A second claim of the same leaf reverts ("already nullified"). `amount > 0` is asserted in both public claims (`main.nr:95,112`); `u128` arithmetic, no overflow path in the claim itself (the amount is a single value passed through, not summed).
- **Interaction with F-L2-01:** permissionless claim is *why* F-L2-01 bites — anyone, not just the depositor, can call `claim_private`. But that is the bearer model, and the nullifier still prevents *replay*; F-L2-01 is about *recipient substitution on the single allowed consume*, not double-spend. Keep them distinct.
- **No fix.**

---

### F-L2-06 — `set_token` / owner / config initialize-once and 2-step ownership: assessed SAFE (no re-init, no zero-owner lock-out beyond design)

- **Verdict:** Safe. `set_token` cannot be re-pointed; ownership 2-step is correct.
- **Confidence:** High.
- **`set_token` once-only:** `self.storage.token.initialize(token_address)` on a `PublicImmutable` (`token_minter_proxy/main.nr:30-34`). A second `set_token` re-emits the initialization nullifier → reverts (fact #6). So an owner cannot swap the token out from under existing minters after the first set. The `owner == msg_sender` check on `set_token` is redundant with the nullifier guard but harmless. (Note: between deploy and the first `set_token`, `mint_to_*` would read an uninitialized `token` and revert via `read()`'s `is_initialized` assert — fail-closed, not a vuln. Deploy scripts call `set_token` before authorizing the bridge, so the live order is fine.)
- **2-step ownership (bridge):** `transfer_ownership` (rejects zero new owner, `main.nr:46-50`), `cancel_ownership_transfer` (`:52-57`), `claim_ownership` (only pending owner, `:59-65`). Standard, no abuse: the pending owner must affirmatively claim; a typo'd-but-nonzero pending owner can be cancelled by the current owner before claim; zero is rejected at set time. No lock-out, no front-run (claim is gated on `pending_owner == msg_sender`). SAFE.
- **Proxy ownership:** `owner` is a `PublicImmutable` set once in the constructor (`token_minter_proxy/main.nr:25-27`) — the proxy owner is **immutable**, there is no `transfer_ownership` on the proxy at all. This is *stronger* than the bridge (can't be transferred) but also means a lost/compromised proxy-owner key is unrecoverable — reinforces F-L2-02's "make it a multisig" recommendation, since you can never rotate it.
- **No fix** beyond the F-L2-02 governance recommendation.

---

### F-L2-07 — Strand-boundary (content-hash equality L1↔L2) — verified consistent; keystone guards it; one CI-coverage caveat

- **Verdict:** Safe at the byte level; the values match the canonical lib. Flag: confirm the keystone test actually runs in CI (drift would otherwise be silent and strand funds, not steal them).
- **Confidence:** High on equality; the CI-run status is an integration concern surfaced for the L1/JS clusters to confirm.
- **Trace:** The L2 bridge uses the *canonical* `token_portal_content_hash_lib` at the pinned tag (`token_bridge/Nargo.toml` → `v4.2.0-aztecnr-rc.2`). `get_mint_to_public_content_hash(owner, amount)` binds `selector || recipient || amount`; `get_mint_to_private_content_hash(amount)` binds `selector || amount` (recipient-free, the root of F-L2-01); `get_withdraw_content_hash(recipient, amount, caller)` binds `selector || recipient || amount || caller` (`upstream` lib `lib.nr:5-81`). The L1 `TokenPortal` builds the same via `abi.encodeWithSignature("mint_to_public(bytes32,uint256)"|"mint_to_private(uint256)"|"withdraw(address,uint256,address)")` (`TokenPortal.sol:68,100,139`). Selectors and arg order match. The keystone pins three fixed vectors (`keystone/src/main.nr:16-35`) and per `bridge-aztec/README.md` the matching L1 assertions live in `bridge-evm` (`WitnessHash.t.sol`) + TS (`bridge-core/src/l1.test.ts`).
- **Why it matters here (L2 angle):** a drift makes the L2 `content_hash` not equal the L1 message content → `consume_l1_to_l2_message` fails `l1_to_l2_msg_exists` → claim reverts forever → funds strand on L1 (recoverable on L1 only via portal mechanics, not by the L2 contract). It does **not** mint free tokens (a non-matching hash can't be consumed). So this is a strand risk, not a theft risk — but it is the one cross-toolchain invariant the TXE can't catch, hence the keystone.
- **Caveat for the cross-cluster reduce:** the keystone is a `bin` crate test; verify CI runs `nargo test` against the rc.2 toolchain for it (the README says "Run: nargo test (with the rc.2 nargo)" and notes "CI must pin this toolchain version"). If the keystone is committed but not executed in CI, the guard is decorative. Not an L2-contract code defect; raised so the L1/CI cluster confirms execution.
- **No contract fix.**

---

## What I could NOT fully verify (honesty notes)

- **TXE PoCs not executed.** The repo pins aztec-nr `v4.2.0-aztecnr-rc.2`, compiled only via the rc.2 `aztec` CLI + `bb` transpiler (`scripts/compile.sh`); I did not run a TXE/sandbox here. All findings are source-level. F-L2-01 and F-L2-02 are the two that warrant an actual TXE PoC before sign-off; both PoC recipes above are concrete and sandbox-bounded.
- **Keystone CI execution** — see F-L2-07; status is a CI-config question for the L1/JS cluster, not determinable from the contract sources alone.
- **The Wonderland `token` contract's burn-authorization internals** (the `authwit_nonce` semantics that make F-L2-04 safe) were taken as canonical per the run's negative list (third-party `aztec-standards` token); I confirmed the bridge passes `self.msg_sender()` as the burn target, which is the part in scope.

---

## Severity tally (auditor's bands, no CVSS number per instructions)

| ID | Title | Band | Status |
|---|---|---|---|
| F-L2-01 | `claim_private` bearer secret, recipient unbound | High (accepted-risk today / High-if-leaked) | Live, deferred mitigation |
| F-L2-02 | Uncapped, un-timelocked, immutable-owner minter authority | High (centralization / key-compromise blast radius) | Live, missing safeguard |
| F-L2-03 | Pause TOCTOU across private→public | Informational | Killed (safe by atomicity) |
| F-L2-04 | `exit_to_l1_*` third-party burn | Informational | Killed (safe) |
| F-L2-05 | Permissionless claim / replay | Informational | Killed (safe; replay nullifier-blocked) |
| F-L2-06 | initialize-once / 2-step ownership | Informational | Killed (safe; proxy owner immutable = note) |
| F-L2-07 | Content-hash strand boundary | Informational (strand, not theft) | Safe; verify keystone runs in CI |

**Two live findings (both High-band, both design/centralization rather than code defects): F-L2-01 and F-L2-02. No way found to mint free tokens from outside the allowlist, claim someone else's funds without the secret, bypass pause across the private→public boundary, or replay a consumed leaf.**
