# Phase 10 — Testnet deploy + owner sign-off (Arc 5)

**Status: IN PROGRESS — the owner authorized the live arc** ("copy it, and you are
authorized to deploy. Including the seed tokens."). The `packages/bridge-core/.env` came from the
owner's copy (six keys; nothing was created). The sign-off remains a live wallet-seam walk.

## Live log

- Pre-flight: node `5.2.0-nightly.20260815`, identity `11155111/1821665230` (walletChainId
  `1816023401`), L1 addresses byte-equal to the committed `aztec-5.0.0-stable` baseline → no reset,
  `NO_RESET_BASELINE` holds. Signer `0xFcc2238319aC360e985f1736aBB3df6251DAF6F5` at 6.3989 ETH,
  nonce 5276 before the arc. forge 1.7.1, `~/.aztec/versions/5.2.0` installed.
- **Seed tokens deployed** (`scripts/deploy-seed-tokens.ts`, new: `MintableERC20`, 6 decimals,
  cap 1,000,000 whole/tx — the sandbox's shape, so the manifest's `maxWholePerTx` is true on chain;
  the v1 `TestUsdc` `0x032E…2448` has a 1,000 cap and stays v1's):
  - `USDC` `0x8648424f0eae2368555d080c948b622d992651fc` (tx `0xf8d39341…3178b073`)
  - `USDT` `0x8badb545be5d79f28d516844bf1713cc7a3f238f` (tx `0x254cb898…779687b6`)
  Both sort below WETH `0xfff9…`; read back `symbol`/`decimals=6`/`maxMintPerTx=1e12` on Sepolia.
  `SEED_TOKENS=0x8648424f0eae2368555d080c948b622d992651fc,0x8badb545be5d79f28d516844bf1713cc7a3f238f`
- Intent built and committed; `verify` green; `deploy --dry-run` green (L2 deployer
  `0x1a12051c0f347210d0d8bd062ec81f9e1adb9b211f458b2e678331eb925a9191`, sponsored-FPC-paid).
- **Deploy run 1 died at the class publication** — `UniswapFuelSwap` landed at
  `0x43857b88e2f625c873c051834fc51558801c4bb3` (journalled), then `publishContractClass(Token)` was
  rejected with `Invalid tx: Existing nullifier`: the aztec-standards Token class is already
  published on the shared testnet (the sandbox is a fresh chain, so the rehearsal never saw this),
  and `publishIfAbsent`'s no-op regex knew only the `already|duplicate nullifier|Nullifier already
  exists` wordings. Fix-forward: ask `node.getContractClass(id)` first, and recognise
  `Existing nullifier` when a publication still loses the race (unit-pinned). Intent rebuilt
  (the tool refuses a verify after a deploy-relevant source change); the
  rebuilt baseline is 6.3932 ETH, so the arc's true spend = 6.3967 − final (swap target ≈ 0.0035 ETH
  is outside the tool's tally).
- **Deploy run 2 died before the journal** — at `deployAccountIfAbsent`: run 1's account deploy
  HAD landed (tx `0x117f443d…fcee83`, block 67829, checkpointed, 0.99 FJ sponsored), but an account
  deploy publishes no instance, so `node.getContract(from)` answers null forever and the helper
  re-sent the deploy into `Existing nullifier`. Every conductor re-run of a deployer account had
  this latent (the smokes use fresh accounts; the sandbox never re-runs). Fix-forward:
  the served-instance fast path stays, then the account's siloed initialization nullifier
  (`computeSiloedPrivateInitializationNullifier(from, instance.initializationHash)` — the wallet's
  own `requiresInitialization` check) is asked of the node. Unit-pinned; intent rebuilt.
- Deploy run 3: resumed from the journal (swap target adopted, account detected, `Token class
  already published` — the diagnosis confirmed).
- **PrivateFPC gate is RED on this node** (`check-fpc-version.ts --mode require-deployed`: node
  `5.2.0-nightly.20260815` is not in the descriptor's compat list `[5.0.0, 5.0.1]`). Pre-existing
  and owner-ruled: an earlier plan's Ask 1 chose to LEAVE the testnet map
  as-is, knowing the gate exact-matches the rotating nightly string. Consequence here:
  `fuel-testnet.ts` runs that gate inline before any broadcast, so the heavy validator, its
  `PRIVATE_RUNS=1` settle-canary and the third-token registering sample cannot run on this node.
  Calibration therefore uses `smoke-swap`'s self-paid `claim_public` (the one paid plain claim
  the candidate smokes produce) and the runbook's fallback for `fjRegister`: the sandbox's measured
  register EXCESS scaled by the ratio of the two networks' `claim_public` samples. The private-FPC
  fuel lane on 5.2.0-nightly stays unproven — an owner call (re-curate the compat list → re-canary),
  not this arc's.
- **Generation landed (run 3, 10.1 min, exit 0)** — journal
  `packages/bridge-core/deploy-journal/testnet-generation.jsonl`:
  - `UniswapFuelSwap` `0x43857b88e2f625c873c051834fc51558801c4bb3` (run 1)
  - `PortalFactory` `0xcb00b6b713f6170e1a42cb8ff933866e46945edc` (impl `0x3ffbd5a0…aaad2`),
    `SwapBridgeRouter` `0x218e782b748ce61d5c5d48d92dfbe55396353816`,
    `TokenBridgeHub` `0x0c1e649c332328319a8c559dbbe7a7290dc91a2487c05372e82c13c8c0715a7f`
    (Token class `0x0225da0f…ef2cf`, already published on the network; hub class published by us);
    readbacks ✓ (`factory.L2_HUB`, router `FACTORY/FEE_ASSET/permit2/feeJuicePortal/swapTarget`,
    `hub.token_for(0) == 0`). Guardian L1 = the signer; guardian L2 = the deployer account.
  - USDC → portal `0xd97917c37294a073b90e0e6a9ded8345f1fdb757`, L2 `0x00242d87…6502`, registered,
    USDC/WETH pool seeded (fee 3000 / tick 60, price within tolerance).
  - USDT → portal `0x3896dfb982a66ef992020e0fc8066956a3e694bd`, L2 `0x14c11c3c…ed96`, registered,
    USDT/WETH pool seeded.
  - `apps/tools/public/testnet-bridge.candidate.json` written (schema 2, walletChainId 1816023401,
    `fjPerTx`/`fjRegister` = `0` placeholders — the live file is v1, nothing to carry).
  - `verify-l1 --strict` on the candidate: **passed** (bindings, both tokens' portal derivation +
    frozen registration + live metadata, three masked runtime code hashes).
  - Spend after the deploy: 0.5136 ETH by the tool's tally (+ ≈0.0035 for the run-1 swap target).
  - `BRIDGE_MANIFEST=public/testnet-bridge.candidate.json verify:deployments`: hub + both L2 tokens
    re-derive to the committed addresses.
- **Smoke run 1 died at the first claim** — `smoke-existing`'s USDC public deposit landed (leaf
  63287296, 1 USDC to a throwaway account, abandoned) and the immediate hub claim simulated into
  `Tried to consume nonexistent L1-to-L2 message` — the message was not in the L2 tree yet, which
  is exactly what `claimTokensUntilSynced` exists to wait out, but its predicate knew only wordings
  no 5.x node emits (`L1 to L2 message.*not found` never matches `No L1 to L2 message found`), and
  it DID retry `No non-nullified …`, the already-consumed case (30 min of waiting for nothing). The
  sandbox never surfaced it: its smoke forces a block before every claim. Fix-forward:
  the app's classification (`nonexistent L1-to-L2 message` · `l1_to_l2_msg_exists` ·
  `message not in state` · `(?<!non-nullified )No L1 to L2 message found`), consumed surfaces at
  once; unit-pinned with both live wordings. Intent rebuilt.
- **Smoke run 2 — green.** `smoke-existing`: USDC public (leaf 63292416) + private (63294464),
  USDT public (63297536) + private (63299584), each claimed via the hub after its message synced
  (`✅ CANDIDATE smoke PASSED — 2 tokens bridged public + private … 12.3m`). `smoke-swap`: 1 USDC
  fueled send → quote 40.93 FJ (floor 39.70) → token leaf 63302657 / fuel leaf 63302656 → the
  self-paying hub claim landed (`✅ FUELED smoke PASSED … 3.5m`, FJ gained 38.334 of 40.930).
- **Calibration** (`fees.json` outside the repo): the self-paid
  `claim_public` (tx `0x2ce6bdf3…0104`, block 67877) cost `transactionFee = 2595637213604538218`
  FJ-wei (= the FJ delta exactly). No registering sample is producible on this node (see the FPC
  gate above), so the runbook fallback: sandbox register excess `9936986600000` × the fee ratio
  `2595637213604538218 / 14821340800000 = 175 128.4` = `1740248237868576233` → a synthesized
  `register_and_claim_public` sample of `4335885451473114451`. `calibrate` wrote
  **`fjPerTx = 3114764656325445862`** (3.1148 FJ) and **`fjRegister = 2088297885442291480`**
  (2.0883 FJ); `minFuelFj` stays `29580299742031535464`. Follow-up: replace `fjRegister` with a
  real registering sample once the private-FPC lane is unblocked (`pre-create --no-register
  --seed-pool --token <third>` + `fuel-testnet --token <third>`).
- `verify --candidate`: strict verify-l1 + hub initialization readback green; digest
  `a27da4727a75fc7c35893d72cf1bbda68d386a296b3aec7494a0d2f43802ca9a` recorded → intent committed.
- **`promote --bridge-only` is BLOCKED by the same FPC gate** (`live-intent.ts` runs
  `check-fpc-version --mode require-deployed` inline before the live write). Evidence for the owner's
  ruling: the pinned FPC `0x1a6d21ce…1bc0` is deployed with `original == current ==
  0x032bc73c22b1d0ab26cce0c99d7ab71f0078962f9a92b060cc9c5cb87e4cfb08`, which is exactly the class the
  installed `@alejoamiras/private-fee-juice` 5.0.1 artifact computes — the compat-list string is
  the gate's only red component; the rollup did not reset, and every 5.0.1-compiled Noir contract
  this arc touched (hub, Token, the private claims) executed on this node. Owner options:
  (a) append `"5.2.0-nightly.20260815"` to `compatibleNodeVersions[d5a2453c…]` in
  `packages/bridge-core/src/private-fpc-canonical.json` (a curated ruling by the descriptor's own
  policy) → `promote` → `fuel-testnet.ts` `PRIVATE_RUNS=1` as the re-canary; (b) hold the promotion.
  Never hand-copy the candidate.
- **Owner ruling (in chat: "I vouch for that")** → `5.2.0-nightly.20260815` appended to
  the descriptor's compat entry; `private-fuel.test.ts` 9/9; the gate green
  (compat + identity + digest + live class). Intent rebuilt → digest re-recorded
  (same `a27da472…`, the candidate was untouched) → **`promote --bridge-only` landed**
  (receipt beside the intent; the faucet file byte-pinned unchanged). The receipt writer
  used to hardcode the 5.0.1 arc's lessons dir and overwrote that arc's receipt — restored, and the
  path now derives from the intent.
- Gate-independent canaries (candidate): **fee-juice direct lane ✓** (16 FJ deposit at leaf
  63311872 → self-paid claim landed 14.7287 FJ, fee 1.2713 FJ, 3.6 min) · **drip ✓** (1e9 units of the
  first faucet token to a fresh account, 0.5 min). Live-file canaries after promotion: `verify:l1 --strict` ✓,
  `verify:deployments` ✓.
- **Re-promotion**: the tools manifest test (`bridge-generation.test.ts`) pins `privateFpc.address`
  on every shipped manifest and the conductor wrote the candidate without the block the placeholder
  carried. Fix (`privateFpcBlock()` from the pinned address + the descriptor's
  version/digest); the conductor re-run resumed everything from the journal (no broadcast) and
  rewrote the candidate with the block and the budgets carried from the live file; intent rebuilt,
  digest `deb70e43…` recorded, promoted again; test 8/8, strict verify-l1
  and verify:deployments green on the live file.
- **Fuel canary run 1 failed on its own default**: `FUEL_SLICE` = 0.25 USDC quotes 10.19 FJ on the
  new pools, under the 29.58 FJ `minFuelFj` floor, so the router's floor guard reverted
  (`UniswapFuelSwap: insufficient output`) before anything moved — correct behaviour; the old v1
  pool priced 0.25 USDC above the floor. Re-run with `FUEL_SLICE_UNITS=1000000` (1 USDC → 40.66 FJ):
  public lane ✓, private-FPC run recorded below. Follow-up: derive the script's default slice from
  the floor and the live quote instead of a fixed quarter unit.
- The conductor's `deploy-journal/testnet-generation.jsonl` stays local (untracked, allowlisted):
  its run-3 `candidate-written` line carries an absolute path (fixed for future runs),
  and the path hook refuses it. Every address it holds is recorded above.
- **Fuel canary, private-FPC lane (the settle canary) — a real app bug found live.** Run 2
  (1 USDC → 40.397 FJ bridged) was refused by the FPC: `Amount too low to cover gas cost`. Run 3
  (3 USDC → 117.34 FJ) settled — actual claim fee **1.786 FJ** (≈909,600 L2 gas at
  `feePerL2Gas` 1.96e12, DA fee 0), public lane 2.585 FJ — so the script's derived "getFeeLimit ≈
  3.06 FJ" could not explain a 40 FJ rejection. Root cause: `@aztec/wallet-sdk` 5.2.0
  `base_wallet.js:218` fills `gasLimits ?? maxTxGasLimits` (the node's `txsLimits.gas`: 6,540,000
  L2 / 117,668 DA), and the PrivateFPC asserts `amount >= Σ gasLimit·maxFee` (the LIMIT, no refund):
  6.54M × (predicted-worst × 1.5 ≈ 6.2e12) ≈ 40.5 FJ — exactly where the 1 USDC run fell short.
  The app's direct Fee Juice lane (`fuelClaim.ts`) already documents and handles this with explicit
  `PRIVATE_CLAIM_GAS`; the hub's private-FPC claim (`deposit-flow.ts` `privateFpcFee`) and the
  validator declared no limits. The sandbox's fee schedule (6.54M × its fee ≈ 0.00007 FJ) could never
  show it, and the manifest floor `minFuelFj` = 29.58 FJ was BELOW the live ceiling — a user
  bridging exactly the floor would have had a private fuel claim the FPC refuses until fees drop.
  Fix: `PRIVATE_HUB_CLAIM_GAS = { daGas: 100_000, l2Gas: 2_000_000 }` (2.2× the landed
  claim) + `privateFpcFeeLimit` in `private-fuel.ts`; the app declares the limits and `stop`s a
  bridged amount under the committed ceiling before the FPC can reject it (`deposit-flow.test.ts`
  16/16, `private-fuel.test.ts` 11/11, tools 1086, bridge-core 427); the validator declares the same
  limits and prints the exact ceiling (`Σ limit·committed fee`) instead of a used-gas ratio. Ceiling
  at today's fees ≈ 12.4 FJ → floor/ceiling ≈ 2.4×; the runbook's 4× policy would put `minFuelFj` at
  ≈50 FJ — left for the owner (a one-sample number may only raise the floor; raising it re-runs the
  candidate → verify → promote cycle since the conductor writes the constant).
- **Fuel canary run 4 (fixed code, `PRIVATE_RUNS=1`, 1 USDC slice) — green, the settle canary.**
  Public lane: 38.62 FJ bridged (token leaf 63380481 / fuel leaf 63380480), claim fee 2.606 FJ.
  Private-FPC lane: 38.37 FJ bridged (leaves 63383553 / 63383552) — the amount the FPC refused in
  run 2 — **claim settled**, fee 1.762 FJ, exact committed ceiling 6.598 FJ. `✅ 2 fueled runs
  SETTLED in 7.0m`. Printed `minFuelFj calibration: 26.39 FJ` (4× the ceiling) < the live floor
  29.58 FJ, so the floor stands (a one-sample number may only raise it). `fjPerTx` sample 2.606 FJ
  ×1.2 = 3.127 FJ vs the promoted 3.115 FJ (+0.4 %, inside the margin) — not worth a re-promotion;
  fold into the next calibration.

## Codex review of the live fix-forwards (session `01a067a0-d197-7733-b88a-b078790910bc`)

Round 1 (fresh session, xhigh, read-only): "request changes" — two highs, three
mediums, one low; the init-nullifier and message-classification fixes clean.
- HIGH `hub-l2.ts` `firstPrivateClaim` — VERIFIED REAL: the app's ladder hands ONE `fee.opts` to
  `claimViaHub`, which paid `register_token` AND the claim with it; a mint-and-pay fee spends the
  bridged Fee Juice message once, so a fueled private first claim on an unregistered token could
  never claim (registration consumed the message). Neither the sandbox (its private flows ran on
  registered tokens) nor the smokes (pre-created = registered) could see it. Fix: a
  `registerFee` seam in `SendOpts` — `splitRegisterFee` gives the registration `registerFee` and the
  claim `fee`, stripped before the wallet; the app's ladder and the validator set it to the sponsor
  on the private-fuel lane. Codex's alternative (mint-and-pay for the registration, then the FPC
  balance for the claim) was rejected: registration is public-effect anyway and the sponsor lane
  exists, and it keeps ONE FPC ceiling instead of two.
- HIGH `private-fuel.ts` limit sizing + "margin costs nothing" — VERIFIED: the FPC's Noir (in the
  artifact's `file_map`) credits `amount − max_gas_cost` and refunds nothing, so limit and padding
  are Fee Juice the claimer forfeits. The comment now says so; 2.0M kept (init-shape headroom, and
  a first claim on an unregistered token cannot be simulated at all — the derived token's
  constructor is enqueued).
- MEDIUM ×1.5 padding — dropped in the app's private lane and the validator (`RELIABILITY_PAD`
  default 1): predicted-worst only, the direct lane's policy; retries re-price.
- MEDIUM floor 29.58 vs 4× — left to the owner (runbook: a one-sample number may only raise; the
  settle canary's 4× = 26.39 FJ is under it). Codex's note: sum both transactions when
  registration is required.
- MEDIUM `generation.ts` — the nullifier rejection is trusted only once `node.getContractClass(id)`
  serves the class; a phantom rejection throws and journals nothing (tested).
- LOW `bridge-generation.test.ts` — the full `privateFpc` triple is pinned.
Gates after the round: bridge-core 428, tools 1086, lint 0, typecheck 0.

Live validation of the seam (also the runbook's registering-sample path): third seed token
**EURC** `0xc10bcb5a0519934e68b489a3a89ee28af8624d24` (tx `0x23b9e385…2a02`), pre-created on the
candidate WITHOUT hub registration → portal `0x1b7806120b80f674719ae7e1be0cc039cc10ae34`, EURC/WETH
pool seeded; then `fuel-testnet.ts --token EURC PRIVATE_RUNS=1` — **green in 7.8 min**: the public
lane landed as **`register+claim`** (`register_and_claim_public`, fee **4.621 FJ** — the real
registering sample; EURC is now a registered, ordinary third token), the private lane a plain
`claim_private` through the FPC (fee 2.845 FJ, exact ceiling 7.10 FJ at that moment). Printed:
`minFuelFj` 4× = 28.41 FJ (< 29.58, floor stands), `fjPerTx` sample 2.845 FJ, `fjRegister` hint
**1.776 FJ** (register+claim − plain). Because the public lane registered EURC first, the private
lane did NOT exercise the sponsor-paid `register_token` path — a fourth token with
`PUBLIC_RUNS=0` does that.

**GBPC — the seam, live.** Fourth seed token `0x177EaD2a677858e376941390548FcF01A6ebeFCa` (tx
`0x7ce5738d…9fa85`, nonce 5363; it sat pending for minutes because I let it sign concurrently with
the EURC canary from the same key — the runbook's "serialize the deployer" rule, relearned — and my
retry mined a duplicate, unused token at nonce 5364). Pre-created without registration → portal
`0x12c3db4596443e4c211bfe7c9c3d316ce57ad85d`, pool seeded. `fuel-testnet.ts --token GBPC
PUBLIC_RUNS=0 PRIVATE_RUNS=1`: three L2 transactions in order — the throwaway account's deploy
(sponsor, `0x2e5b67d1…d646`), **`register_token` paid by the sponsor (`0x2f31…9c3b`, 5.32 FJ)**,
two "claim not ready" waits while the message synced, then **`claim_private` paid by the bridged
fuel through the FPC (`0x139bcd59…1449`, 2.98 FJ)**. The outcome path printed `claim` because the
retry after the waits found the token registered (codex's "registerTxHash is lost on a throw after
the registration" — cosmetic here; the registration and the claim both landed). Ceiling 7.44 FJ;
printed `minFuelFj` 4× = **29.77 FJ > 29.58** — with three live private ceilings (6.60 / 7.10 /
7.44) that is the full calibration, so the floor is RAISED to `29773418555864000000`
(`MIN_FUEL_FJ` in `deploy-generation.ts`).

**Recalibration** with every paid claim the validators landed (seven plain samples across both
lanes, worst 2.98 FJ; the EURC `register_and_claim_public` 4.62 FJ): `fjPerTx` 3.578 FJ,
`fjRegister` 1.967 FJ (the calibrator's worst-registering minus worst-plain, now measured rather
than scaled from the sandbox). Candidate rebuilt from the journal with four tokens (USDC, USDT,
EURC, GBPC — the last two registered by their first claims), the new floor and these budgets →
`verify --candidate` (strict verify-l1 on all four tokens + hub readback green, digest
`ba7ced36…`) → **promoted** (first attempt died on a DNS blip before any write;
the retry landed). Live-file canaries: `verify:l1 --strict` ✓, `verify:deployments` ✓ (hub + four
L2 tokens re-derive). Gates: `bun run test:all` exit 0, `bun run lint` exit 0;
pushed (`gh stack push`).

Codex round 3 (resume): the ChatGPT backend answered 404 on both attempts
(`turn.failed`, `codex login status` fine) — codex is down; the owner said to wait for it. The
verification prompt is written (self-contained
for a fresh session) and ran once the service returned.

Codex round 3 (fresh session `01a067d9-8bb6-7d51-b6f8-024b4b3d0e92`, `codex-vTD5Lw2i`):
"Verdict: fixes are sound against the installed wallet-sdk 5.2 behavior,
but one medium recovery-state bug remains." — `deposit-flow.ts:646 · medium`: the app's
`claimAttempt` latch (`fee.onAttempt` in `useSend.ts`) fired BEFORE `claimViaHub`, which now runs
the sponsored `register_token` first, so a registration that fails (a rejected prompt, a revert)
spends no fuel yet reads as a pending private fuel claim for the 15-minute stale window. VERIFIED;
fix: `SendOpts.onClaimSend` — `claimViaHub` fires it once, right before the claim's own
transaction (after any registration; never on a registration that throws), stripped from sends and
simulations with the other seam key; `useSend` passes `fee.onAttempt` through it. Pinned in
`hub-l2.test.ts` (ordering across all three claim shapes, the throw case, the stripping). Gates:
bridge-core 429, tools 1086, typecheck 0.

Codex round 4 (resumed): "Verdict: the latch placement and wallet-option stripping are correct,
but the exactly-once callback contract has one race hole." — `hub-l2.ts:144 · low`: a lost public
registration race fired `onClaimSend` before `register_and_claim_public` and again before the
fallback plain claim. Fixed: one call before the try (both transactions are the same
attempt), the lost-race case pinned (`register_and_claim_public → claim_public`, one callback).
Lint 0; `test:all` exit 0 (the previous top); re-run: recorded below.
Codex round 5 (resumed): "Verdict: correctly makes the public lost-race fallback one
logical attempt while preserving wallet-option stripping. no new material findings." — the live
arc's fix loop has converged (rounds 1–5, one fresh session after the outage).

## CI on the promoted manifest, and the preview for the sign-off

The PR went red on both `Build Tools` jobs (testnet + mainnet → `quality-status`): the tools
app's jsdom smoke (`tests/e2e/tools-smoke.test.ts`, run inside the build gate) lost 3 of 8 cases.
Until P10 the shipped testnet manifest was a placeholder (`bridge: null`), so the smoke never met
the hub; with the live bridge block, connect-time `registerHubContracts` re-derives the hub and
every manifest token through the smoke's gutted `getContractInstanceFromInstantiationParams`
mock (`0x0`), the instantiation check rightly refuses it, the connection wedges in `error`, and
drip/disconnect cascade. Fix (test-only): the hub and hub-token instances are pre-baked
in the smoke like every other contract module there; 20/20 locally. The base branch has not moved since the
rebase, so the stack is current.

**Preview for the wallet-seam walk**: the preview builds the tools app per PR branch with the
testnet values.
Verified serving the promoted manifest: schema 2,
walletChainId 1816023401, hub `0x0c1e649c…`, USDC/USDT/EURC/GBPC, `fjPerTx` 3.578 FJ,
`build.json` `manifestDigest` `ba7ced36…` = the intent's candidate digest, `buildId 0.1.0`.

Round 2 (resumed): "close" — one wallet-boundary miss, one policy point, one known
gap, one nit.
- MEDIUM `useSend.ts` `probeHubClaim` simulated with the seam key still in the options (the
  wallet's option parser spreads unknown keys) — VERIFIED; fixed: `claimSendOpts`
  (exported from `hub-l2.ts`, tested) strips it for the simulation as for the send.
- MEDIUM "make `registerFee` mandatory when the private token is unregistered" — NOT adopted:
  reusable fees (the sponsor, an account's own Fee Juice) legitimately pay both transactions, and
  every script/sandbox caller relies on that; the app's fuel lane always sets the seam. The
  invariant is stated on the type.
- MEDIUM the validator pre-deploys the account, so the first-ever-account initialization shape
  the 2.0M limit reserves headroom for stays unmeasured — the same KNOWN GAP `fuelClaim.ts`
  documents for the direct lane; follow-up: a wallet-driven e2e or a fresh undeployed-account
  FPC claim.
- LOW the manifest test now compares the `privateFpc` triple to the descriptor's exact values.

## Pre-flight the agent completed

- The stack is rebased on the base branch with every gate green per commit
  (`lessons/rebase-onto-base.md`); the loops converged (arcs 1–5, the cross-arc pass, the rebase
  verification).
- The runbook is `.claude/skills/aztec-update/SKILL.md` § Branch B — steps 3–4 and 8–9 are this
  phase; steps 1–2, 6–7, 10 do not apply (no reset: the testnet identity `11155111/1821665230` is
  unchanged, so `NO_RESET_BASELINE` holds and `live-intent build` runs as-is).
- The sandbox rehearsal (Branch B step 3) on the rebased chain: see "Sandbox rehearsal" below.
- `TOKEN_LIST_LIVE=1` real-origin canary: green (and it caught the list going multi-chain — `lessons/phase-9.md`).
- The seed tokens (`SEED_TOKENS`) must be the committed fake-USDC / fake-USDT `MintableERC20`
  addresses on Sepolia, each sorting below WETH (`token < 0xfff9…`) — record them here before the
  run; `--dry-run` validates only their shape.

## Owner runbook (in order; every command from the repo root)

1. `packages/bridge-core/.env`: `PRIVATE_KEY` (the plan-pinned testnet signer — the conductor
   refuses any other), `SEPOLIA_RPC_URL`, `BRIDGE_DEPLOYER_SECRET_TESTNET` (≥ 16 chars; the SAME
   value on every re-run — it derives the L2 deployer; pre-fund that account's fee juice or let the
   sponsored FPC pay its deploy). The guardian: the conductor records the L1 signer as `guardianL1`
   and the L2 deployer as `guardianL2` (the dedicated recorded testnet guardian — note both
   addresses below).
2. `bun packages/bridge-core/scripts/live-intent.ts build implementations-plan/archive/any-erc20-bridge/lessons/intent.json`
   → commit the intent.
3. `SEED_TOKENS=<fakeUSDC>,<fakeUSDT> bun run --cwd packages/bridge-core deploy:generation deploy --dry-run`
   then the same without `--dry-run` (~15 min of real proofs; journalled — a crash is re-run with
   the SAME command; read the journal's last line against the chain first).
4. `bun packages/bridge-core/scripts/live-intent.ts verify <intent>` (no `--candidate`), then the
   candidate smokes: `smoke-existing-testnet.ts --config apps/tools/public/testnet-bridge.candidate.json`,
   `smoke-swap-existing-testnet.ts --config …`, `fuel-testnet.ts --config …`.
5. Calibrate (`fees.json` OUTSIDE the repo; a registering sample needs
   `pre-create --no-register --seed-pool --token <third mintable>` + `fuel-testnet.ts --token <third>`):
   `bun run --cwd packages/bridge-core deploy:generation calibrate --config <candidate> --samples <path>/fees.json`.
6. `live-intent.ts verify <intent> --candidate <candidate>` → **commit the intent** →
   `live-intent.ts promote <intent> --bridge-only` → commit `apps/tools/public/testnet-bridge.json`.
7. Canaries: `verify:l1 --config apps/tools/public/testnet-bridge.json --strict` ·
   `BRIDGE_MANIFEST=public/testnet-bridge.json bun run --cwd apps/tools verify:deployments` ·
   `fuel-testnet.ts` with `PRIVATE_RUNS=1` · `fee-juice-canary-testnet.ts` · `drip-canary-testnet.ts`.
8. Deploy `testnet.app.unleashed.systems` (the PR branch builds as a preview).

## Wallet-seam checklist (D34) — owner, live

- [ ] register-and-claim public of a PASTED token: one grant prompt at Sign & send, one claim.
- [ ] the 2-tx private first claim: `register_token` then `claim_private`, auto-continue, two prompts.
- [ ] gas-only: the swapped slice arrives as Fee Juice and pays its own claim.
- [ ] an exit: the burn authwit prompt, burn before finish, the L1 consume.
- [ ] a paused-exit rejection: `set_exits_paused(true)` from the testnet guardian, the preflight
      refuses before any burn, unpause.

## Sandbox rehearsal (agent, post-rebase)

`bun run --cwd packages/bridge-core deploy:sandbox --smoke` on the rebased chain, the
5.2.0 JS line, an OWNED local network: **all 16 flows ✅, 6.5 min, exit 0** — (a) public claim,
(b) private claim + relayed claim + wrong-recipient rejection, (c) token+gas self-paying claim,
(d) gas-only into the FeeJuicePortal, (e) public + private exits through the Outbox, (f1) relayer-first
registration, (f2) two concurrent first-time deposits, (f3) portal-only token registering on its first
claim, (f4) routeless refusal before signing, (g) tampered registration rejected under sponsored /
fee-juice-with-claim / private-FPC, (h) guardian pause blocks exits and not claims. Calibration
identical to the P6 run: `fjPerTx=17785608960000`, `fjRegister=11924383920000` (local fee schedule —
the testnet numbers come from step 5). The conductor path (`generation.ts`, `deploy-manifest.ts`,
`deploy-sandbox.ts`, the hub-l2 / send-flow modules) is therefore proven on the post-rebase tree
with the base branch's journal ports in place.

## Owner walk of the preview → the UX arc

The owner walked the preview before signing off and sent the wizard back: the step chips, the paste
box, the provenance chips, the "First time for this token" label, the mint card, the MAX button, the
change/done toggle on the gas card, the "out of the gas you are buying" fee line, the gas-only
"Token arrives = 0" line, and RUN IN BACKGROUND landing on a populated step 3. Two of those were
not copy: USDC (registered) showed the first-time path on a plain Ethereum wallet, and the
"network fee" was the whole gas budget captioned as a fee.

A design canvas (four mint variants) was approved with no changes; the mint decision moved to
variant B (a testnet-only strip, the flow otherwise identical on both networks). The arc is
[send-wizard-ux](../../send-wizard-ux/plan.md), a branch above the stack, four
commits (token step, amount step, review, wizard). Findings while building it:

- **The first-time false positive was the wallet seam.** `useTokenSelection` only read the hub's
  `token_for` through the connected Aztec wallet, so without one every registered token read as
  portal-only. The binding is now read from the node's public storage: `token_of` is a
  `Map<EthAddress, PublicImmutable<AztecAddress>>` at slot 9 of the hub artifact's `storageLayout`,
  the entry's own slot holds the address (`WithHash` packs the value first), zero means unbound.
  `hubBindingAt(node, hub, erc20)` in bridge-core; no wallet, no simulate.
- **A token-only send is never sponsored.** `gateNoFuelClaim` reads the recipient's public and
  private Fee Juice and STOPS with "No gas (Fee Juice) to claim this no-fuel bridge" when both are
  zero — on every network, not only mainnet. The review said "paid by the sponsor". It now says
  "paid from the gas you already hold on Aztec", and the amount step reads the same two balances
  (`useGasHeld`) and blocks Token alone while both are known to be zero, before any Ethereum
  signature. Unknown (no account, unreadable) blocks nothing; the claim's gate fails closed.
- **The fee is one transaction, not the budget.** The review's Fee line is `fjPerTx` (plus
  `fjRegister` for an unregistered token), stated as the first of the N transactions the bought
  gas covers; the gas leg itself moved to the Arrives line.
- **`deriveStorageSlotInMap` is async in 5.2.** The Promise typed through to
  `getPublicStorageAt` until awaited.
- The preview for the sign-off is the PR's own; the five-item checklist below is unchanged.

**`/code-review medium --fix` on the arc** (a fresh adversarial reviewer over the branch diff, one
file at a time): 1 HIGH, 5 MED, 5 LOW; all fixed in one commit except two LOWs kept on purpose.

- HIGH — RUN IN BACKGROUND was undone: the send lane resolves only once the whole bridge is done,
  so `runSend`'s `adopt(id)` fired after the reset, and `adoptRunRecord` re-adopted the record on
  the engine's next write. Both adopt sites now skip the backgrounded id and the id joins the
  pre-submit set; the test releases the lane AFTER the background, the one ordering production has.
- MED — the step strip rendered the raw token symbol (every other surface goes through
  `safeDisplay`); the node outage on the binding read threw the client's raw error (now a readable
  fail-closed message — fail-open would bring the false first-time path back on a blip); the gas
  stepper's text field kept a refused value on screen (snaps back); the disabled outcomes' reason
  lived only in `title` (now `aria-describedby` too); row balances were keyed on the unfiltered
  catalog, so a row past the first fifty never showed one (now keyed on the rows on screen and
  remembered per row).
- LOW fixed — "≈ 0 transactions" on a quote under one budget; `formatCompact` ate a whole number's
  zeros at zero decimals; "sponsor" wording in a prop doc and a `data-route` value.
- LOW kept — the slot-derivation test derives its expectation with the same helper the code uses
  (the reviewer re-derived it by hand against aztec-nr `with_hash.nr` / `derive_storage_slot_in_map`
  and found it right; a TXE fixture is the stronger pin and is not worth a toolchain run for a UI
  hint); one `mintL1` testid on every mint button, disambiguated by `data-symbol`.

**Codex round 1** (session `01a06880-b0b4-79e2-ab58-5e7536d63a5b`, xhigh, read-only): "request
changes — hub storage lookup is correct, but background rekeying and gas gating still have material
holes." 1 HIGH, 3 MED, 3 LOW; all but one LOW fixed.

- HIGH — a backgrounded PUBLIC deposit or any withdrawal starts as a provisional record the journal
  rekeys once its transaction names it; the new id was neither the backgrounded one nor in the
  pre-submit set, so the wizard re-adopted it. The journal now records every rekey (session-scoped,
  like `sessionLive`) and exposes `canonicalRecordId`; the wizard follows it in every adopt guard
  and in the strip's lookup.
- MED — a no-gas verdict landing AFTER the review was frozen left Sign & send enabled:
  `tokenOnlyBlocked` joins the review-invalidation sources, `onConfirm` refuses past it, and the
  amount step re-reads the balances on entry.
- MED — NEW SEND kept the resolved token, so a token the send had just registered would be priced
  with `fjRegister` and worded first-time again: the token is re-resolved and the gas target reset.
- MED — the strip formatted a gas-only record's amount (the swapped token amount) as 18-dec FJ; the
  strip's subject is now the review's promise line ("≈ 5 FJ gas from 1 WBTC").
- LOW fixed — non-manifest display symbol/name sanitised once at resolve; two pre-existing
  BridgeStepper comments naming a plan step and a codex finding rewritten; sponsor wording in the
  plan and a test fixture.
- LOW kept — a chain switch during an in-flight lookup could show a wrong-chain identity in the ADD
  row; the selection fails closed on `assertL1Chain` and the row is only a hint, so no live-chain
  watch was added.

**Codex round 2** (resumed): "rekey handling is fixed correctly, but three material gaps remain."
All three fixed; the LOW declined.

- MED — confirm trusted the gas verdict cached when the amount step opened, so gas spent elsewhere
  meanwhile could sign a deposit its claim would then strand. `onConfirm` now re-reads the two
  balances before a token-only deposit signs (the buttons are held by `submitting` while it reads)
  and stands the review down if the gate closed.
- MED — the background reset re-resolved the token at once, before the backgrounded send had
  registered it, so a next send prepared from it kept the first-time pricing. The token is
  re-resolved again when the backgrounded record completes, which also stands down a review priced
  for a first send.
- MED — the promise line used `fuelFj`, the sizing target, which a gas-only send outgrows (the
  whole amount is swapped): it now states the quote, as the review did.
- LOW declined — codex asked for the review/codex logs to be struck from `phase-10.md` and the plan
  as "forbidden breadcrumbs". The ban is on CODE comments; `implementations-plan/**/lessons/` is
  where this repo records exactly these consults.

**Codex round 3** (resumed): one HIGH, my own making in round 2. Awaiting the gas read with
`submitting` set muted `invalidateReview` for that window, so an account switched during the read
was ignored and the send would have targeted the live account under a review frozen for the old
one; the same guard muted the re-resolution behind a backgrounded send (`submitting` spans the
whole lane), leaving a next review priced first-time. Fixed: the read runs under its own
`preflighting` lock (buttons held, review live); only a review still standing when the read
returns goes on to sign; and the invalidation guard exempts a review built while a backgrounded
send runs — the review that must not move is only the one being signed. Two gated tests pin the
account switch under the read and the next review behind a backgrounded send.

**Codex round 4** (resumed): one HIGH on that fix. The post-read check compared the review's PLAN
to the one confirmed, but the wizard's plan is a computed that does not depend on the Aztec
account: switch accounts during the read, re-enter the review, and the new review carries the same
plan object — the earlier confirm would resume and sign under the new account. The check is now on
the review SNAPSHOT's identity (a re-entered review is a new snapshot) plus the account it was
frozen for; a gated test re-enters the review under another account and shows the first confirm
signs nothing and the new review signs only on its own confirm.

**Codex round 5** (resumed): "Looks ready. no new material findings" — the arc's loop converged.
Five rounds; the last three were all on the confirm-time gas read I added in round 1,
which is the lesson: an `await` inserted between "the user confirmed" and "the send starts" opens
a window every reactive source can move in, and the review snapshot's identity — not its plan, not
a flag — is the only thing that says the confirm still applies.

## Owner walk of the PR preview — round 2

Ten items. Four landed straight away; five are design choices put on a second canvas for the
owner to pick from; the receipt (item 9) is deferred to a later arc at the owner's request.

- Landed: the "Minting — confirm in your wallet" line goes (the button says MINTING…); picking a
  row IS the token step — the wizard moves to the amount at once on the row's own symbol and reads
  the token behind it, CONTINUE held until the read lands, a failed read brings the user back to
  the row with the reason; the "Checking gas options…" and "sizing…" loaders go (nothing shows
  until there is an outcome); Details: the token and the portal are Etherscan links on their full
  addresses, the route names the currencies it walks ("USDC → ETH → Fee Juice on Uniswap v4
  (2 pools)"), and "Portal: verified…" becomes the address plus one word of state.
- On the canvas: the max/"Use all" control (item 4), the fee copy (6), where "private" sits on the
  Arrives line (7), the "How the gas is sized" disclosure (8, four or five ways), and the wallet
  permission for a new token as a stepper phase — before DEPOSIT or before CLAIM (10).
- Item 10 has a safety edge the canvas has to show: the grant is raised BEFORE the L1 deposit today
  so a declined permission costs nothing; raised at claim time it would leave a deposit waiting on
  Ethereum until the user grants it.

**The owner's picks (same day)** — Max: the balance line itself is the tap, no arrow (my take on
their "B without the arrow": the amount reads as the control by being the only primary-coloured
text on the line, accent on hover; a plain secondary line would hide the affordance entirely).
Fee: A — "≈ 3.57 FJ" with "taken from the gas that arrives" as a soft clause. Visibility: B, the
row named "Visibility", copy "Private — only you can see it" (the owner's point: it is the fee
juice too, not only the token). Gas sizing: none of the five — the disclosure is gone; the two
arrival lines are the whole card, the capped note stays when it applies. Permission: A, as a phase
before DEPOSIT, copy "Allow reading USDC state in your Nulo wallet." Plus: REGISTER was only shown
after the fact (once `registerTxHash` existed, private only); the record now carries `registers`
from the plan, so a private send shows REGISTER ahead of CLAIM from the start and a public one
labels the single tx REGISTER + CLAIM.

- The permission phase is shown without moving the grant: it is still raised before ANY signature
  (a decline costs nothing), so no journal record exists while the wallet decides. The wizard builds
  a stand-in record from the plan (provisional id, so nothing offers to back it up), renders the
  stepper on it with a `granting` runtime override and no RUN IN BACKGROUND, and the real record
  takes the stepper over the moment the engine files it; the engine marks `grantOutcome` on that
  record so PERMISSION stays on the rail as the run's first, done phase. The phase rail had to take
  the override too — it re-derived the phases from the journal on its own.
- The smoke case "a grant that lands after the user picked another token is discarded" described a
  path that no longer exists (the review is gone while the wallet decides); it now pins the
  permission phase instead. The engine's epoch check for a superseded grant stays as the net.

**Codex round 6** (resumed, on the round-2 delta): "not ready; the core journal/rekey design
holds, but the delta introduces four material transition/UX regressions." All four MED fixed, two
of three LOW fixed, one LOW declined.

- MED — a grant that THREW (not declined) left the permission screen up forever: the send's
  rejection skipped the cleanup after the await. The await is in a `try/finally`; the wizard returns
  from `permit` either way and the review shows the error.
- MED — a private send: `openSendRecord` awaited the seal before `markGrantOutcome`, so the record
  watcher adopted a rail without PERMISSION and the phase was inserted retroactively after SEAL.
  The outcome is marked right after the record is filed, before the seal.
- MED — picking token B while A was still resolved rendered the amount step on A's symbol and
  decimals until B's read landed, and the row-symbol fallback bypassed `safeDisplay`. `amountToken`
  uses the read only when its address is the picked row's, and sanitises the row's symbol.
- MED — with picking-as-the-step, ↑/↓ in the list emitted `select` on every row, so the first arrow
  press left the catalog. Arrows move focus only (the tab stop follows focus); Enter/Space/click
  pick.
- LOW fixed — every stand-in record shared one id, so the rail's phase clock carried the previous
  prompt's elapsed time onto the next (the id is now fresh per prompt); the backup validator let
  `registers: "yes"` through by spread (it is now `undefined | true`, deposits with a token leg
  only).
- LOW declined — codex flagged "plan/phase/review terminology" in comments; the lines it cited are
  pre-existing (`plan S3/S10`, `plan S15`, "codex post-impl HIGH" in the journal and rail), untouched
  by this branch. They are a repo-wide sweep of their own, not a rider on a UX PR.

**Codex round 7** (resumed): one MED on my round-6 fix — the wizard now recovered from a grant
that threw, but the send composable never caught it: `ensureGranted` sat outside `performSend`'s
normalising try/catch, so `error` stayed null and the rejection escaped the click. The grant is now
awaited under its own catch that files the humanised message; the wizard test asserts the review
shows it, and `useSend.test.ts` pins that a throwing grant resolves empty with the error set.

**Codex round 8** (resumed): "Ready. … no new material findings" — the round-2 arc converged.
`/code-review` was NOT run on this round: the owner asked for it to be dropped as too
token-intensive; the codex loop is the review from here on.

CI: quality green; one red on the known runner CDP flake, on a diff that does
not touch it. Re-run `--failed` once, per the standing rule; never neutralised. The
rerun passed.

## Owner walk of the PR preview — round 3

Three items, "not much more … great work":

1. **The Aztec panel flipped to "Setting up session…" while the wallet asked for the token
   permission.** Real bug: `retryCapabilities` re-ran the connect statuses (`capability-approval`
   → `setting-up` → `connected`) on a session that was already connected, so the panel read as a
   connection lost and re-made while the stepper's own PERMISSION phase was narrating the prompt.
   A re-grant from a connected session now keeps the status put throughout; a retry from an error
   state still walks the statuses as a fresh connect does. The session test pins that no status
   change is observed across a connected re-grant.
2. **"What happens with Register when the user has no gas?"** — answered from the code, no change:
   - A private first send is two transactions from the user's account: `register_token` (a PRIVATE
     hub function whose only public side effect is `_register(erc20, portal, token)` — no account
     in it), then `claim_private`. A public first send is one: `register_and_claim_public`.
   - Fueled private: the registration is paid by the SponsoredFPC (the bridged Fee Juice message
     can be consumed by one transaction only, and that is the claim's, via the PrivateFPC's
     `mint_and_pay_fee`). Publicly the register tx shows the SponsoredFPC as fee payer and the
     token's words; the claim shows the PrivateFPC as fee payer. Neither carries the account.
   - No fuel (the account already holds gas): both transactions go with NO fee option, so the
     wallet's own picker chooses — exactly what a no-register private claim does today. That is
     the "same behaviour" asked for. The honest caveat: the picker can choose PUBLIC Fee Juice,
     which makes the account the visible fee payer of a private claim; that is the wallet's
     default to fix (out of bridge scope, D34), not something the bridge decides.
   - No gas at all: unreachable from the wizard since this arc — the amount step blocks Token alone
     while both balances (public FJ, private FJ at the PrivateFPC) are known zero, and the claim's
     own gate fails closed. "Register" for such an account happens only through Token + gas, where
     the sponsor pays the registration.
3. **UNI and WETH showed addresses in the list.** They come from the remote token list, not the
   manifest; the row prints the address for every non-manifest token because a list can label any
   address "USDC". I first moved it to the row's hover title (the approved canvas showed listed
   tokens with a name), and codex objected (MED): a listed token can copy a trusted token's symbol,
   name, decimals AND live metadata exactly, which defeats the review's conflict warning, and a
   hover-only address helps no touch user at the moment of choosing. Codex is right; the address
   is back on listed rows, under the name, in tertiary type. The inconsistency the owner noticed IS
   the signal: manifest tokens are the app's own, everything else says which contract it is.

**Codex rounds 9–10** (resumed, on the third-walk delta): round 9 confirmed the quiet re-grant
(errors still reach `error`; a remembered, still-granted account never re-opens the chooser) and
raised the listed-row address (fixed as above); round 10: "Ready … no new material findings" —
converged.

## The private first claim, re-planned: fuel on the registration, no sponsor anywhere

The owner's item (2) from the round-3 walk, and a standing ruling that came with it: **assume
sponsorship is never available — no bridge path may lean on it, on any network.**

**What was wrong.** "Token + gas, private" on a first-time token was two transactions with two
payers: `register_token` paid by the SponsoredFPC, then `claim_private` paid by the PrivateFPC's
`mint_and_pay_fee`. The sponsor does not exist on mainnet (the mainnet app is a placeholder today —
`App.vue` renders `MainnetPlaceholderView`, `mainnet-bridge.json` has `bridge: null` — so the path
was unreachable rather than broken, until a mainnet generation ships). And the hand-off between the
two transactions was a race the owner had hit: `firstPrivateClaim` waited for the register to be
PROPOSED, checked `token_for` (a public view, simulated against the NODE's latest state) and sent
`claim_private` at once — a private function whose `portal_of` read runs in the wallet's PXE at
the PXE's synced anchor block, which lags the node, so the claim's simulation failed on a
zero portal.

**The plan (seventh PR of the stack).**
- The registration spends the bridged Fee Juice (`mint_and_pay_fee` in its setup, sized with the
  new `PRIVATE_HUB_REGISTER_GAS`); the FPC keeps `amount − max_gas_cost` as the claimer's private
  credit; the claim after it pays from that credit (`pay_fee`, `PRIVATE_HUB_CLAIM_GAS`). hub-l2
  seams: `registerFee` / `registeredClaimFee` / `onRegisterSend` / `onRegistered` /
  `registrationWait`; a lost race keeps the plain claim with the plain fee.
- The claim is sent only once its own simulation passes in the claimer's wallet (5 s polls,
  3-minute deadline, the failure names the register hash). The simulation is the one probe that
  sees exactly what the send will see — the binding AND the FPC credit note from tx 1.
- The fuel latches follow the transaction that spends the fuel; `onRegistered` journals
  `registerTxHash` and the fuel hash in one write; a not-yet-consumable message and a dropped tx
  are provably unspent (retry allowed); spent fuel on an unclaimed token pays the claim (and, if
  still unregistered, the registration) from the FPC credit instead of dead-ending.
- No sponsor on any bridge path: the public fee-spike and override/consumed cases pay from the
  wallet's own gas (gated like a no-fuel claim); the standalone Fee Juice claim self-pays; the
  sponsor grant travels with the drip scopes alone.
- The private gas slice is sized from LIVE predicted fees: `fjCeilings` (claim + register ceiling
  when unregistered) replaces the calibrated `fjRegister`; "pricing" until fees load; a slice whose
  guaranteed floor cannot cover the ceilings is refused before any signature; the covered count
  is derived from the floor, never the target; the confirm re-prices and stands the review down.

**Live canary — green on the first run (`fuel-testnet.ts`, fresh token JPYC
`0xbb38c95cf10cd035f9a2e94ffb61eeb8b32a12fb`, pre-created without registration on the candidate,
pool seeded, `PUBLIC_RUNS=0 PRIVATE_RUNS=1 FUEL_SLICE_UNITS=2000000`), 4.8 min end to end.**
Recipient `0x033b7336…68e98`; 2 JPYC → 80.07 FJ bridged to the FPC. Three "claim not ready"
waits while the messages synced, then `register_token`
`0x181429d0e5d5216360637c7004a96f6577c46aed415f787a548dc11e4e580ca0` landed paid by the fuel
(**3.3955 FJ, ≈1,763,076 L2 gas** at that block's L2 price), the claim waited for its own
simulation to pass in the wallet, then `claim_private` settled paid by `pay_fee` from the credit
(**1.5818 FJ, ≈821,331 L2 gas**). Path `register,claim`; committed ceiling (both limits) 14.21
FJ at that moment. The register limit was set from this: **`PRIVATE_HUB_REGISTER_GAS = {daGas
100_000, l2Gas 4_000_000}`** (2.3×, the claim's headroom policy; provisional 4.5M before the
measurement). Known gap, same as the claim's (fable H1): the canary's account was already
deployed — an account whose first-ever transaction is the registration carries its
initialization on top, and only the wallet produces that shape.

**Codex (fresh session `01a06960-e908-7350-a496-274188c9a0c8`), round 1 — "Request changes",
six findings, all addressed in `fix(bridge): a reverted registration keeps its hash…`:**
- CRITICAL: a registration that reverts past its non-revertible setup spent the fuel but the
  wallet's wait threw, so the hash was never journalled and the 15-minute stale window retried a
  `mint_and_pay_fee` that could only fail as consumed. Fix: the register's wait carries
  `dontThrowOnRevert`; a reverted receipt fires `onRegistered` with the hash then throws;
  `fuelReceiptStatus` reads `*_reverted` as included (spent).
- HIGH: consumed fuel + still-unregistered token had no plan (one ceiling, no register seam).
  Fix: the credit branch gates both ceilings and supplies `registerFee` + `registeredClaimFee`
  from `pay_fee`.
- HIGH: the half-of-the-deposit cap could ship a slice under the mandatory ceilings while the
  review still promised the target's transaction count. Fix: `privateSliceShortfall` refuses the
  slice before a signature; `txCoveredOf` counts from the signed floor minus the mandatory part.
- HIGH: the register limit was not measured against an undeployed account — recorded as the known
  gap above, not fixable by a canary.
- MEDIUM: "pricing" was neither fresh nor visible. Fix: `pricingError` surfaces a failed read; a
  price older than 5 min sizes nothing; the confirm re-primes and invalidates a review whose slice
  no longer covers the ceilings.
- MEDIUM: removing the sponsor from `sendScopes` also removed it from the COMBINED manifest, which
  the testnet drip still needs. Fix: the sponsor now travels with `dripScopes` (both simulate and
  send), so a network without a faucet carries none.

**Codex round 2 (resumed) — three more, all addressed:**
- HIGH: the wallet honours only `NO_WAIT` and reads the receipt ONCE,
  immediately — so a registration comes back `pending` with no `executionResult`, and a later
  revert would have surfaced as the three-minute visibility timeout (the hash was already latched,
  so recovery was safe, only slow and misleading). Fix: `receiptOf` seam — hub-l2 follows the
  registration on the node until it is mined, reverted (hash reported, then throw) or dropped
  (nothing spent, retry).
- HIGH: confirm-time repricing failed open — a failed refresh with a ≤5-min cached price let the
  confirm proceed. Fix: `prime()` reports whether a fresh price landed; the confirm stands the
  review down with a named reason otherwise.
- MEDIUM: gas-only coverage counted the optimistic quote. Fix: every leg counts from the signed
  floor.
- Also caught on my side: the revert lives in the receipt's `executionResult` ("success" |
  "reverted"), NOT in `status` (a reverted transaction's status is a mined one) — the first fix
  read the wrong field.

**Codex round 3 — one HIGH, addressed:** a transient `receiptOf` rejection inside
the fate poll escaped BEFORE `onRegistered`, leaving a hashless fuel attempt that would retry
`mint_and_pay_fee` against a spent message forever. Fix: the hash is journalled the moment the
wallet returns it (before the receipt read, the wait, or any judgment), and a failed read leaves
the fate unknown until the deadline. The dropped case now reports the hash too — the journal's
own receipt probe reads it as dropped and lets the fuel retry.

**Codex round 4 — converged:** "the hash-loss path is correctly closed; **no new
material findings**."

**Cost of the plan, stated plainly for the owner:** a first-time private bridge forfeits two
committed ceilings (register + claim) from its gas — 14.2 FJ at the canary's fees against 4.98 FJ
actually charged. That is the price of "no sponsor"; the alternative (one private transaction
that registers and claims) needs a hub change and a new generation.

## Owner walk — round 4, and the sponsor that leaked through the public ladder

**The private first claim worked on the preview** ("worked wonderfully" — AUDC, token + gas,
private, first-time token: register from the fuel, claim from the credit). Three copy/UX notes
came back, and one real bug.

**The bug (owner-found, live):** a first-time PUBLIC token + gas send (WETH) reached the wallet's
confirmation with **Sponsored FPC** as the fee method. The ladder's three no-fee outcomes
(`no-fuel`, `own-gas`, `own-gas-standalone`) all sent the claim with `fee` omitted so "the
wallet's own picker chooses" — and the wallet's picker defaults to the sponsored FPC on an
account with no public Fee Juice.
The gate that unblocked it counted the owner's PRIVATE
balance at the PrivateFPC as "has gas", then handed the choice to a picker that cannot spend it
by default. Which of the three outcomes fired is not in the log we have; all three are closed.

**First fix — rejected by codex, correctly** (resumed session
`01a06960-e908-7350-a496-274188c9a0c8`, round 5): it named a payer per claim — the account's
public Fee Juice as the transaction's own fee payer (`preexistingFeeJuicePayment` with the
sender in its payload), else the private balance through `pay_fee`. Three HIGHs, all verified:
- The wallet routes any payload whose payer is the sender as `FEE_JUICE_WITH_CLAIM`,
  and that entrypoint mode "will set itself as the
  fee payer but NOT end setup phase" — the Fee Juice contract's `claim_and_end_setup` does. With no
  claim call the app phase never starts: invalid. **A dApp could not name the account's public
  Fee Juice through the Nulo wallet.** (No fee-mode field crosses the wallet-sdk RPC that the
  wallet reads.) That is now a wallet change of its own.
- `useSend.ts` computed `registers` as `rec.isPrivate && hubMissing`, so a public first-time claim
  was sized as a plain claim while hub-l2 sent `register_and_claim_public`; with `pay_fee` that
  exhausts the limit AFTER the full ceiling is deducted.
- The wizard's token-only gate (`useGasHeld.verdictOf`) counted any non-zero balance — one wei of
  credit unlocked the irreversible L1 deposit, and the claim stopped later.
- MED: a private record silently falling back to a public payer; MED: the public register+claim
  shape reused the 4M private-registration limit, unmeasured.

**Second fix — a claim from held gas pays ONLY from the private balance at the FPC:**
- `decideOwnGasCredit({ privateFeeJuice, ceiling })` → pays / short / unverifiable / none; the
  ceiling comes from the claim's SHAPE via bridge-core's `ownGasTxs` / `ownGasCeiling`: a public
  claim is one transaction (`PUBLIC_HUB_CLAIM_GAS` 3.0M L2, `PUBLIC_HUB_REGISTER_CLAIM_GAS` 3.5M
  when the hub does not know the token), a private first-time token sends a registration first
  (4M + 2M, on the `registerFee` / `registeredClaimFee` seams). The public limits are DERIVED from
  the landed public-lane fees (plain `claim_public` 2.585 FJ beside a 909,600-gas / 1.786 FJ
  private claim ≈ 1.32M L2 gas; EURC `register_and_claim_public` 4.621 FJ beside a 2.845 FJ private
  claim ≈ 1.48M) × the claim's 2.3× headroom — PROVISIONAL, no FPC-billed sample of either exists;
  the owner's WETH retest on the preview is the first.
- `useSend.ts` asks the hub whether the token is bound for BOTH privacy modes.
- The wizard reuses the same ceiling: `useGasHeld.credit`, `useGasShare.ownGasCeilingFor`; the
  token-only card greys out on an empty OR a short balance once priced; the confirm re-reads the
  balance and re-prices, and stands the review down unless the balance is KNOWN and covers the
  fresh ceiling (unread / unpriced / short each named).

**Codex round 6 — one HIGH, mine:** the payload change to `preexistingFeeJuicePayment`
had broken the mainnet deploy script, because wallet-sdk's own `completeFeeOptions`
(`base_wallet.js:185-192`) routes a sender payer as a claim in setup exactly as the wallet
does, and only an ABSENT payer as preexisting. Fix: the payload is empty again (the
aztec.js meta method still reads the sender through `getFeePayer()`), the doc states both
routings; the token-only review shows the ceiling and that the fee contract keeps it in full; a
caller test pins `registers` for public records; the public limits are documented provisional.

**Codex round 7 — no HIGH; one MED closed:** the review snapshot now
carries the ceiling it SHOWED; at confirm a review that opened unpriced stands down once the figure
exists, and one whose figure grew by more than a tenth stands down as moved.

**Codex round 8 — converged:** "no material findings beyond the acknowledged
provisional public gas limits; the review-disclosure MED is correctly closed." (One LOW, a test
isolation nit, folded in.) All gates green.

**Copy/UX:** claim eta → "a moment, then your signature"; registered detail →
"registered - preparing the claim"; a trailing "." is an amount still being typed (no red line,
CONTINUE off); the gas breakdown's error waits for the same 700 ms pause / blur as the field's own
(it was rendered immediately, which is why the debounce "was not really working").

**Owner retest to run on the preview:** the WETH public token + gas first-time send again. With no
public Fee Juice the claim pays from the private FPC balance — the wallet's confirmation must show
no fee picker (an embedded, dApp-named payer), and the claim lands at the derived public ceiling
(3.5M L2 × predicted fee set aside, no refund). That run is also the first billed sample of a
public registering claim through the FPC.

## Sign-off

**Owner sign-off.** After the fourth walk (the private first claim on the preview,
the sponsor leak found and closed, the wallet's dApp-named self-pay shipped,
the CADC token minted with its portal created and its pool seeded for the retest), the
owner wrote: "No more feedback. Happy to sign off on merging the stack." The merge itself
(`gh stack merge`, landing every PR below the named one) is the owner's action, never the agent's.
