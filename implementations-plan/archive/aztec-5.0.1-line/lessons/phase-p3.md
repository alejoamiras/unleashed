# Phase P3 — network e2e under 5.0.1: the standards swap + its P6 coupling.

P3 itself was the wallet's deletion fence. What this repository took from the phase is the blocker
below: the cause sat in the standards package, and the swap that fixed it couples to P6.

## The wallet's network e2e went red under 5.0.1 — evidence-based finding below

### ✅ STANDARDS SWAP DONE — network root cause FIXED (verified via repro). Now P6-coupled.
Executed the swap: `@alejoamiras/aztec-standards@5.0.0` → `@aztec-foundation/aztec-standards@5.0.1`
across all 5 package.json + 33 import sites (scope-only; identical `artifacts/src/artifacts/*.js`
paths) + bunfig exclude + the `@wonderland-token-artifact` vite alias. **Repro-VERIFIED:
`0x0193c31b`/"not registered" is GONE** (the 5.0.1 token references the 5.0.1 HandshakeRegistry that
EXISTS on the 5.0.1 sandbox). typecheck:all 0, lint 0, unit suites green (bridge-core
136; the lone `@unleashed/tools useL1FeeAsset` fail is the known cross-run flake —
426/426 isolated).
- **Constructor arity**: 5.0.1's `Token.constructor_with_minter` added a 5th param `auth_contract`;
  the wallet's e2e fixture now passes `AztecAddress.ZERO`.
- **P6 COUPLING (now concrete)**: the same 5-arg constructor change breaks `verify:deployments` +
  `apps/faucet/scripts/deploy.ts` + `deployments.ts` + `deploy-bridge-testnet.ts` + `deposit-testnet.ts`
  (they pass 4 args to derive the token address). Those pass the LIVE token's 5.0.0 args (4); the token
  must be REDEPLOYED with the 5.0.1 5-arg constructor (P6) and the deployment descriptors regenerated
  before verify:deployments can pass. So the faucet build is P6-blocked — exactly the "fee-payment/
  standards identity shift couples to P6" the plan anticipated. The deploy-script arity + descriptor
  updates are PART OF P6's redeploy (live, hard limit → needs the user). Both the standards token AND
  the fee-payment PrivateFPC (0x1a6d21ce) redeploy in P6.

### ✅✅✅✅ ACTUAL ROOT CAUSE (from SOURCE, after the fee-payment hypothesis ALSO proved wrong)
`grep 0x0193c31b node_modules` found it: **`0x0193c31b` = `HandshakeRegistry`** in
`@aztec/standard-contracts@5.0.0`'s `standard_contract_data.ts` — pulled transitively by the
**5.0.0-HELD `@alejoamiras/aztec-standards@5.0.0`**. The e2e test TOKEN is compiled from those 5.0.0
standards, so its notes reference the **5.0.0 HandshakeRegistry (`0x0193c31b`)**, which is NOT deployed
on the 5.0.1 e2e sandbox → 5.0.1 note-sync throws "not registered" → the account sync aborts →
the wallet's token import hangs → every test behind it fails.
- **The fee-payment bump did NOT fix it** (0x0193c31b is UNCHANGED after bumping fee-payment 5.0.0→5.0.1;
  I verified via the repro). My "fee-payment PrivateFPC phantom" diagnosis was WRONG — but the
  fee-payment bump is still valid P4 work (the plan requires it; bridge-core 136 tests green; PrivateFPC
  re-pinned 0x257aa870→0x1a6d21ce, artifact sha256 → 94fa4c71; couples to P6 as expected). Kept.
- **The REAL fix is P4's STANDARDS SWAP** — `@alejoamiras/aztec-standards@5.0.0` →
  `@aztec-foundation/aztec-standards@5.0.1` (whose `@aztec/standard-contracts@5.0.1` has the 5.0.1
  HandshakeRegistry that DOES exist on the 5.0.1 sandbox). This was my ORIGINAL hypothesis (which I
  wrongly abandoned). The P4 standards trust-gate is already CLEARED (see phase-p4.md). Swap surface:
  33 import sites across the apps and packages + 5 package.json.
- **This connects to the earlier P4-coupling read** — the network gate IS coupled to P4, but via
  STANDARDS (the token's HandshakeRegistry), not fee-payment. 7 wrong contract IDs before the source
  grep nailed it — the lesson: grep node_modules for the literal address FIRST.

### ✅✅✅ (SUPERSEDED — the fee-payment theory) NETWORK ROOT CAUSE — DEFINITIVE (node lookup). It is P4-coupled.
Node lookup during the local repro: **`node.getContract(0x0193c31b)` → `onNode=false`** — `0x0193c31b`
is NOT deployed on the 5.0.1 e2e sandbox; it is a PHANTOM address. And it is DETERMINISTIC (identical
every run). Traced to source:
- `@private-fpc-artifact` (vite alias) = `@alejoamiras/aztec-fee-payment`'s
  `target/private_contract-PrivateFPC.json` — the **5.0.0-HELD** fee-payment package (P1 held
  fee-payment + standards at 5.0.0 → they move in P4).
- The wallet registers a PrivateFPC derived from that 5.0.0 artifact (`0x257aa870`); the theory
  was that reading it makes the 5.0.0-compiled PrivateFPC call a contract at `0x0193c31b` that the
  **5.0.1 sandbox does not deploy** → the account note-sync aborts.
- **THE FIX IS P4's fee-payment bump.** `@alejoamiras/aztec-fee-payment@5.0.1` EXISTS (npm: `5.0.0`,
  `5.0.1-revision.1`, `5.0.1`). Bumping it → 5.0.1 gives a PrivateFPC artifact that matches the 5.0.1
  protocol, so `0x0193c31b`'s reference resolves. (Standards → `@aztec-foundation` scope in P4;
  fee-payment stays `@alejoamiras` scope — there is NO `@aztec-foundation/aztec-fee-payment` (npm 404),
  so the fee-payment "swap" is a same-scope version bump, NOT a scope migration.)
- **STRATEGIC coupling the user must weigh:** bumping fee-payment shifts the PrivateFPC IDENTITY
  (address changes like SchnorrAccount did). The e2e sandbox is **5.0.1** (`Setting up Aztec local
  network 5.0.1`) but the LIVE testnet is **5.0.0**. So a 5.0.1 PrivateFPC artifact fits the e2e
  sandbox but derives a PrivateFPC address NOT deployed on the 5.0.0 live network → live private-fuel
  would break until P6 redeploys (which can't deploy 5.0.1 contracts to a 5.0.0 network). Either (a)
  the e2e sandbox should be pinned to 5.0.0 to match live (testing the real 5.0.1-client-vs-5.0.0-net
  topology the user described), or (b) accept the fee-payment identity shift + sequence P6. THIS IS A
  PLAN-TOPOLOGY DECISION FOR THE USER (their 5.0.1/deploy-strategy call). Note SponsoredFPC is fine
  (its 5.0.0 artifact still resolves — only the PrivateFPC/private-fuel path hits `0x0193c31b`).

`LESSONS_FILE=implementations-plan/archive/aztec-5.0.1-line/lessons/phase-p3.md`
