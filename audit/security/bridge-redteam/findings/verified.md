# Verification ledger — bridge red-team (Phase 3 reduce + Phase 4 verify)

Cross-model convergence is the primary confidence signal. "×3" = found independently by the Opus per-cluster agent AND both Codex passes (L1 + L2/xchain). Main agent (Opus 4.8) re-read every contract and spot-verified the load-bearing facts below.

| ID | Title | CVSS band | Confidence | Found by | Verify verdict |
|----|-------|-----------|-----------|----------|----------------|
| F-001 | `TokenPortal.initialize` permanently re-callable → reserve drain + deposit redirect (LIVE) | **Critical 9.3** | high | Claude + Codex ×3 | CONFIRMED |
| F-002 | L2 `TokenMinterProxy` owner = immutable, uncapped print-and-withdraw into L1 reserves | **High 8.1** | high | Claude + Codex | CONFIRMED |
| F-003 | Contract tests + content-hash keystone not CI-enforced → silent strand on a bad bump | **High 7.5** | high | Claude + Codex ×3 | CONFIRMED |
| F-004 | `swapTarget` owner-mutable but not witness-bound → owner extracts signed slippage on fuel leg | **Medium 5.9** | high (mech.) | Claude + Codex | CONFIRMED |
| F-005 | Exported `runSwapBridge` fail-open for private-fuel invariants (library API; faucet safe) | **Medium 5.3** | moderate | Codex only | CONFIRMED |
| F-006 | `UniswapFuelSwap.swap()` permissionless + caller `minOutput` → direct-call sandwich (self-harm) | **Low 3.1** | high | Claude | CONFIRMED |
| F-007 | Bearer-secret private claim (recipient omitted) — accepted-risk, off-chain custody is the only guard | **Low 2.6** | high | Claude + Codex | CONFIRMED → **FIXED** (recipient-committed, see note) |
| F-008 | `UniswapFuelSwap.sweep` lacks `nonReentrant` (router's sweep has it) — latent | **Low 2.0** | high | Claude | CONFIRMED |
| INFO-1 | `MintableERC20` permissionless mint + Permit2 allowance override — testnet footgun, not a theft path | Info | high | Claude + Codex | CLEARED as non-exploit; flagged for prod |
| INFO-2 | L1 deposits not gated by L2 pause → in-flight strand during a paused incident (liveness/UX) | Info | high | Claude | CONFIRMED (liveness) |
| INFO-3 | `deposit-testnet.ts` guesses Inbox leaf index via `simulateContract` (script-only) | Info | high | Codex | CONFIRMED (script) |

> **F-007 FIXED — recipient-committed private claim.** The `bridge-permit2-recipient-commitment` plan closed this: `claim_private` now takes a per-deposit `claim_salt` and re-derives the consumption secret from `poseidon2([claim_salt, recipient], DS=3140354885)` in-circuit (`contracts/bridge/aztec/claim_secret/` ↔ TS `deriveTokenClaimSecret`, keystone-pinned both toolchains). A leaked salt can only claim to the ORIGINALLY-BOUND recipient — so a relayer can finish a stranded claim but never redirect it, and the salt is a strand-prevention + linkage-privacy credential, not a bearer credential. The **real driver was the relayer capability**, not this Low-2.6 finding. Requires a fresh L2 stack (the deployment migration is part of that plan); the old bearer deployment keeps bearer semantics for its in-flight claims. **INFO-1 remains a hard blocker for any value token** — `MintableERC20`'s permissionless mint + forced-Permit2 allowance is testnet-only and must not survive into a value-bearing deployment.

## Spot-verifications performed by the main agent (against ground truth)

- **F-001 live premise**: `packages/faucet/public/testnet-bridge.json:5` pins `portal = 0x9c41…11ea` (git-tracked, UI-wired via `bridge-deployments.ts`). The vendored `TokenPortal.sol:37-46` `initialize` has no `onlyOwner`/`initializer`/first-call guard (read directly). `withdraw` (`:146-148`) does `outbox.consume` then `underlying.safeTransfer` — a fake registry→rollup→outbox makes `consume` a no-op, so `withdraw` drains the real held `underlying`. Drain path is real.
- **F-002 immutability**: `token_minter_proxy/main.nr:26` is `owner.initialize(msg_sender)` and grep confirms **no** `transfer_ownership`/`claim_ownership`/`set_owner` exists — the proxy owner is a permanent, unrotatable EOA. (The TokenBridge has 2-step ownership; the proxy does NOT.) Drain path mint→`exit_to_l1`→portal `withdraw` verified across both chains.
- **F-003 CI gap**: `rg 'forge test|nargo test|forge build|nargo' .github/workflows/` → **no matches**. `Quality / Status` = Biome + vue-tsc + bun audit only. The content-hash literals match byte-for-byte today (keystone vs ContentHash.t.sol vs L1 selectors — agent table), but nothing recomputes them in CI.
- **F-004 not witness-bound**: `SwapBridgeRouter.sol:52-56` TYPEHASH lists 11 fields; `swapTarget` is not among them, and `setSwapTarget` (`:142`) is instant + un-timelocked. Guards `:196/199/204` bound a hostile target to (≥minFuelOutput out, ==fuelAmount in) but not to fair value.
- **F-005 fail-open**: `flows.ts:259` `const fuelSecret = p.fuelSecret ?? Fr.random()` and `fuelRecipient` is passed through verbatim (`:276,:300`) with no `isPrivate ⇒ == PRIVATE_FPC_ADDRESS` check; the invariant is only a comment (`:216-220`). Faucet `useDeposit.ts` always derives + passes both, so the shipping path is safe.
- **Tree clean**: the l1-router agent's throwaway Foundry PoCs were removed (Codex's `AuditResidue.t.sol`/`AuditWeirdToken.t.sol` references were to those transient files).

## Cleared hot-spots (cross-model agreement they are SAFE — valuable negative results)

- **Permit2 replay / EIP-712 type confusion** — witness binds spender=router + chainId + verifyingContract=Permit2; the 11 fields are consistent across TYPEHASH/TYPE_STRING/`_hashBridgeWitness`/JS mirror; fork test covers nonce/expiry/tamper. (both)
- **Swap guards vs malicious/owner-replaced target** — `minFuelOutput` floor + FJ balance-delta + strict `consumed==fuelAmount` bound principal & fuel leg; over-delivery only strands attacker-funded FJ residue (not user funds). (both, Opus ran throwaway PoCs)
- **Weird `bridgeToken`** (fee-on-transfer/rebasing) — reverts atomically at the consumption check; self-harm only. (both)
- **Native-ETH settlement reentrancy** — `swap()` nonReentrant, `unlockCallback` PoolManager-only, `receive()` inert, V4 reverts on unsettled deltas. (both)
- **Minter-allowlist bypass / pause TOCTOU** — deploy authorizes only the bridge; `#[only_self]` blocks external callers; enqueued pause-assert reverts the whole atomic tx (effective for `claim_private`). (both)
- **Withdraw double-consume / `_withCaller` front-run** — CEI order + canonical Outbox nullifier; recipient bound in the content hash → front-run is griefing/altruism, not theft. (Claude)
- **JS witness/RNG/slippage (faucet path)** — field order matches Solidity; bearer secret is `Fr.random()` (CSPRNG); 3% slippage floor + `minFuelFj` gate; secret sealed at rest, never logged. (both)
