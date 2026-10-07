---
name: bridge-generation
description: Runbook for the bridge's on-chain side across an Aztec-line bump — classifying the bump, the Noir surface and drift detectors, and deploying a new bridge generation (PortalFactory + TokenBridgeHub, then DepositRouter + TestnetFuelSwapper) when the network resets or a class id moves, or a router-only deploy (DepositRouter + TestnetFuelSwapper) on the current generation. Use when bumping Aztec, when a drift detector goes red, when pre-creating a token, calibrating fjPerTx, deploying a new router or refilling and re-pricing the testnet fuel swapper, promoting a candidate manifest, or running the live canaries.
---

# Bridge generation

The bridge's runbook for an Aztec-line bump and for everything that deploys: a network reset is the
one event that runs it in full. The bump itself (pins, lockfile, API churn) is listed in
[`UPDATE.md`](../../../UPDATE.md); this skill is the part that decides whether a bump is also a new
generation, and how to deploy one. Worked examples: the archived
[`aztec-5.0.0-stable`](../../../implementations-plan/archive/aztec-5.0.0-stable/plan.md) (a reset
under the intent tooling) and [`aztec-5.0.1-line`](../../../implementations-plan/archive/aztec-5.0.1-line/plan.md)
plans and their `lessons/`. Non-trivial bumps still get a plan; this skill is the checklist the plan
draws from.

> **This skill is the source of truth for deploying a generation. Update it when the process
> changes**: a new pin, a new failure mode, a toolchain shift. A durable lesson from a deploy belongs
> here, not only in a plan's `lessons/`.

The Aztec line follows the Nulo wallet's repository: it publishes its three shared packages on a new
line first, and `scripts/ci-cd/published-packages.test.ts` holds their peers to this repository's
pin, so a bump cannot start before those versions exist.

## Phase 0 — classify the bump (first; it forks everything)

1. **Did the target network reset?** Probe the live node and compare against the pin:
   ```bash
   NODE=$(rg -o 'https://[^"]+' packages/bridge-core/src/testnet-node.ts)
   curl -s -X POST "$NODE" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}' | jq '.result.rollupVersion'
   rg -n 'TESTNET_ROLLUP_VERSION' apps/tools/src/lib/chain-constants.ts
   ```
   A different rollupVersion is a **NETWORK RESET**: Branch B is mandatory and coupled to the bump.
   `verify:deployments` runs inside the tools build gate, so a class-id or identity shift reds the
   build; the bump cannot land with the redeploy deferred.
2. **What changed upstream?** `gh api repos/aztec-labs-eng/aztec-node/compare/v<old>...v<new>`:
   scan the `!:` commits, then grep this repository for the broken symbols before assuming they
   bite. Expect class-id shifts from any toolchain or bytecode change, even when no API moved.

**Then ask the owner** (`AskUserQuestion` on Claude Code), presenting what the probes found (the
rollupVersions, the `!:` commit count, the hits here), never blind. Nothing starts while any
question is open: batch the exact target version, the validation depth, deployer-key availability
and release timing into the same round.

- **Q1 "Bump class"**: `Version-only bump` (rollupVersion unchanged; pins, toolchain, detectors, no
  on-chain work: Branch A) or `Network reset — coupled redeploy` (Branch B). Recommend what the
  probe supports. There is a third state Q1 cannot see: rollupVersion unchanged but a Phase 1 drift
  detector fires anyway (a toolchain or bytecode change moved a class id). That is a drift-triggered
  redeploy of the shifted contracts; when a detector goes red on a "version-only" run, **stop and ask
  again** (redeploy the shifted set, or abort the bump). Q1 is answered before the detectors run, so
  the first answer is only sufficient together with this second one.
- **Q2 "Live authorization"** (a reset only): explicit authorization for the scripted testnet
  deploys (L1 forge broadcasts, L2 deploys, promotion), naming the keyed-run templates it will use
  and stating whether a credential is created (only ever by the owner's `op-remote create`). Options: `Authorize the full scripted redeploy` /
  `Prepare everything, hold before broadcasts`.

No `--broadcast` or deploy step runs without Q2's authorization. A mid-run surprise that changes the
shape of what was authorized (an unplanned redeploy, a write to something not sanctioned) goes
back to the owner: authorization for one scope does not extend to the next.

## Phase 1 — the bump (always)

Walk [`UPDATE.md`](../../../UPDATE.md)'s pin surface and coupling list first. The bridge's own
surface:

**The Noir surface** (skipping it makes the drift check a false negative):
- `contracts/bridge/aztec/scripts/compile.sh` pins the toolchain (`AZTEC_HOME`, default
  `~/.aztec/versions/6.0.0-rc.1`; `aztec-up install <v>` first) and lists the crates it compiles
  (`token_bridge_hub`, `keystone`; `claim_secret` and `register_hash` are libraries the hub pulls in).
- The `Nargo.toml` git tags (`aztec` and `compressed_string` from `aztec-labs-eng/aztec-nr`, and the
  hub's `token` dep from `AztecProtocol/aztec-standards`, dir `src/token_contract`) sit on ONE tag,
  and every manifest spells the aztec-nr URL exactly as the standards do (no trailing slash), or Nargo
  builds a second `aztec` crate. `token_portal_content_hash_lib` is vendored in
  `contracts/bridge/aztec/` and consumed by path; re-vendor it from `aztec-labs-eng/aztec-node` at the
  new tag and update its header. A mismatch with aztec-nr produces about twenty cryptic
  `Could not determine the value of the generic argument N on 'call'` errors at once.
- **The hub's `token` tag and the JS `@aztec-foundation/aztec-standards` pin are one class.** The
  hub's `token_class_id` is a constructor immutable the conductor computes from the installed JS
  `Token` artifact (`packages/bridge-core/scripts/generation.ts`); every L2 token derives from it
  (`src/hub-token.ts`, pinned by `noir-artifact-classids.test.ts`), and the Noir `token` dep fixes the
  selectors the hub calls on that class. A standards bump that moves the Token class id cannot be
  absorbed by a deployed hub: that is a new generation. Moving the JS pin alone makes every derived
  L2 token address disagree with the live hub.
- Recompile and commit `target/*.json` (a build input, not an on-chain act), then
  `compile.sh --check`: the hub's committed class id must survive the rebuild. A hub class-id shift
  is a new generation, never a re-pin; the deployed hub is immutable and its factory binds it.
- The TXE server's dependencies are the committed mini-project `contracts/bridge/aztec/txe-server`
  (frozen lockfile); `run-txe-tests.sh` never `bun add`s. Bump that lockfile with the Noir line.

**Drift detectors** (run all four; green on a bump-only run, confirming the shift on a reset):
1. `bun run --cwd apps/tools verify:deployments`: re-derives the live dripper and tokens from pinned
   params. With `BRIDGE_MANIFEST=public/testnet-bridge.json` (relative to `apps/tools`, where
   `--cwd` runs it) it also re-derives the live
   bridge manifest with the new artifacts: the hub from its recorded `salt` and
   `[tokenClassId, factory, guardian]`, every L2 token from the hub and its attested words. Run it
   both ways.
2. The PrivateFPC tripwire (`packages/bridge-core/src/private-fuel.test.ts`): fires on artifact or
   bytecode drift. Re-pinning `PRIVATE_FPC_ADDRESS` is a conscious act that owes a live re-canary and
   a note to the Nulo wallet's repository, which pins the same address; never silence the test.
3. `packages/bridge-core/src/noir-artifact-classids.test.ts` and `hub-token.test.ts`: the committed
   hub class id and the standards Token class id the hub derives from. Either moving means the live
   hub cannot be re-pinned, so a new generation.
4. **The sandbox smoke on the JS line**: `bun run --cwd packages/bridge-core deploy:sandbox --smoke`
   boots `aztec start --local-network` from `~/.aztec/versions/<@aztec-labs/aztec.js pin>` (the line
   the live networks run) and drives real `register_*` publications. It is the only pre-live check
   that the compiled hub's `publish_contract_instance_for_public_execution` resolves on the
   protocol's `ContractInstanceRegistry`; the TXE cannot run that path. A red first-time flow holds
   the bump.

## Branch A — bump-only (no reset, detectors green)

`bun run audit:tools` and `bun run test:all` exit 0, the contract suites pass locally, and the PR
carries the `e2e:tools` label (label it after opening it: a label on `gh pr create` cancels the
first run) so the browser suite runs against the new line. `quality-status`, `tools-e2e-status` and
`bridge-contracts-status` green, then merge.

## Branch B — network reset (the coupled redeploy)

A reset means a **new bridge generation**: one L1 `PortalFactory`, one L2 `TokenBridgeHub`, a
`DepositRouter` and its `TestnetFuelSwapper`, and every manifest token pre-created against them.
Nothing carries over except Sepolia itself (the mintable test tokens): the hub's address is salted
with the factory's, the factory's constructor takes the hub, the router binds the factory and the
moved `FeeJuicePortal` as immutables, and the swapper the moved fee asset, so all four redeploy
together, always.

**The whole live arc runs under the deployment-intent tooling.** `bun packages/bridge-core/scripts/live-intent.ts build <intent-path>`
runs after every source change (chainId cascade, L1 constants) has landed and before any signing: it
snapshots the commit, pins the signer against the plan-pinned address (`PLAN_PINNED_L1_SIGNERS`),
records artifact digests and caps, and corroborates the node's identity claims against L1 via
`cast`. Then `live-intent.ts verify <intent> [--candidate <path>]` **before every broadcast group
and at promotion**: it re-probes identity (a rollupVersion that moves mid-arc is a hard stop), re-checks
the signer, the artifact digests, the candidate's sha256 (the first verify records it; any later
change means never promote) and the working-tree allowlist (`OPERATIONAL_ALLOWLIST` in
`live-intent.ts`: the candidate and live manifests, the conductor's `deploy-journal/`, and the named
`lessons/` directories — a new arc adds its lessons directory there first). With `--candidate` it also
strict-validates the candidate through the full `verify-l1` verifier (code at every address, the
factory ↔ router ↔ hub cross-bindings, each token's portal derivation, frozen registration and live
metadata, runtime code hashes against the forge build with immutables and the metadata trailer
masked) and reads the hub's initialization hash off the node to prove it was initialized with the candidate's
`[token_class_id, l1_factory, guardian]`. The caps are recorded and reconciled against the signer's
balance at `verify` (`maxTotalEthSpend` is the balance delta; incoming ETH can mask a spend, so keep
your own tally per broadcast group), not enforced per transaction. Committing does not make a dirty
change acceptable: every path whose contents differ between the intent's `build` commit and HEAD
must be allowlisted too, so a mid-arc source fix voids the intent. Work around a non-blocking defect
and fix it after the final verify. A blocking one stops the arc for the owner: a rebuilt intent
records the current balance and a fresh `CAPS` allowance, never what the old one spent, so recovery
keeps the old intent and journal and reconciles the cumulative spend against the original
authorization before anything resumes. **Commit the intent right after
`build` and again after the digest-recording verify**: the tool refuses a dirty intent only once it
carries `candidateSha256`, so before that only commit discipline catches an edited cap or signer.
**`build` refuses a reset by design**: `assertNoResetPins` byte-pins the node's identity and five L1
addresses against the committed baseline named by `NO_RESET_BASELINE`, and `build` is the only
writer of such a file. So a reset arc bootstraps the baseline by hand, and the node is not trusted
for any of it: a malicious RPC can name contracts that have code and agree with each other.

1. Authenticate the registry and the fee-asset handler **upstream, independently of the node**: the
   network config the pinned `@aztec-labs/cli` reads (`dest/config/network_config.js` names its
   sources). Record the URLs and the package version.
2. Walk the graph from that registry through two independent public Sepolia RPCs:
   `registry.getRollup(<rollupVersion>)` = `registry.getCanonicalRollup()`; then `rollup.getVersion()`,
   `getFeeAssetPortal()`, `getFeeAsset()`; then `portal.ROLLUP()` and `UNDERLYING()`, which must point
   back; and `feeAssetHandler.FEE_ASSET()`. Every node claim must equal these reads.
3. Write `{ identity: { l1ChainId, rollupVersion }, l1: { rollup, feeJuicePortal, feeJuice, feeAssetHandler, registry } }`
   into the new arc's `lessons/` with that evidence, re-point the constant, commit, then run `build`
   against it.

Never loosen the check.

**Pre-flight**: the node runs the new version, and every key reaches its run as a **keyed run**:
`env-exec request --template <template> --slug <name> -- <command>` is filed on the host, the owner
approves it with `op-remote` on the Mac, and the values exist only inside that one process. The
1Password item `Keyed-Runs/Unleashed-Testnet` is created once, whole, from
`packages/bridge-core/testnet-provision.env.example` (`op-remote create` generates the L1 key and
both L2 secrets and imports `SEPOLIA_RPC_URL`). Each run template takes only its own fields:
`testnet-l1.env.example` (intent, smokes, canaries), `testnet-generation.env.example`
(`deploy:generation`; adds `BRIDGE_DEPLOYER_SECRET_TESTNET`, which the L2 deployer derives from and
which must never change while a generation is resumable), `apps/tools/testnet-faucet.env.example`.
`deploy-private-fpc-testnet.ts` needs none. **Surface a missing key; never create one** outside the
owner-approved create. A fresh L1 signer is pinned in `PLAN_PINNED_L1_SIGNERS` and committed before
`build`; the owner funds it.
- `env-exec` pins the request to HEAD and refuses untracked files when filed and again when run (a
  stray `.env` inside a forge `lib/` checkout counts). Commit only between requests: a commit made
  while one is pending voids it, and it is re-filed.
- Confirm `SEPOLIA_RPC_URL` answers chain 11155111 first. A mainnet URL surfaces only as `build`'s
  "node-claimed rollup/portal has no code".

The conductor records the L1 signer as `guardianL1` and the L2 deployer as `guardianL2`. Budget about 15 minutes of real proofs per
conductor run, and install `~/.aztec/versions/<new JS pin>` completely (the sandbox rehearsal refuses
a partial toolchain). Sepolia does not reset: the test tokens persist; everything rollup-coupled
does not.

**Where paths resolve.** Every command runs from the repository root. A script invoked by path
(`bun packages/bridge-core/scripts/<name>.ts`) reads its `--config` from the root, so pass
`apps/tools/public/<manifest>`. A package script (`bun run --cwd <package> …`) runs from that
package, so the same file is `../../apps/tools/public/<manifest>` from `packages/bridge-core` and
`public/<manifest>` from `apps/tools`. Environment variables go before `bun`, never after the
script: an assignment after it is just another argument. `pre-create` and `calibrate` default
`--config` to the candidate.

1. **ChainId cascade.** The wallet chainId is `walletChainIdOf(l1ChainId, rollupVersion) = (l1 ^ rollupVersion) >>> 0`
   (`packages/bridge-core/src/wallet-chain-id.ts`). The literals: `apps/tools/src/lib/chain-constants.ts`
   (and `chain-info.test.ts`), `packages/bridge-core/src/wallet-chain-id.test.ts`,
   `private-fuel.test.ts` and the `private-fpc-canonical.json` identity pins. `rg` the old
   rollupVersion repo-wide and classify every hit. The manifest's `walletChainId` is written by the
   conductor from the node, and the build-integrity check refuses a manifest whose chain disagrees
   with the build target, so the constants and the manifest move together. The Nulo wallet
   keeps its own copy of the chain identity and moves it on its own.
2. **L1 constants.** The conductor reads `registry`, `feeJuice`, `feeJuicePortal` and
   `feeAssetHandler` from `node_getNodeInfo` at run time. The fork fixture
   `contracts/bridge/evm/test/fixtures/lifi/testnet-rail.json` still carries the fee asset,
   FeeJuicePortal and faucet as literals: re-record it (`bun packages/bridge-core/scripts/lifi-fixtures.ts
   testnet-rail --run`) so `LifiTestnetRailFork` keeps testing the live topology.
3. **Rehearse on the sandbox first**: `bun run --cwd packages/bridge-core deploy:sandbox --smoke` on
   the new JS line (drift detector 4): all 31 steps, the PrivateFPC credit flows included, through the
   production modules, real `register_*` publications, the calibration line at the end. Green here is
   the precondition for spending on Sepolia.
4. **Deploy the generation, candidate-first and journalled:**
   ```bash
   # from the repo root, like every command in this runbook
   SEED_TOKENS=<fakeUSDC>,<fakeUSDT> bun run --cwd packages/bridge-core deploy:generation deploy --rates <abs path>/rates.json --dry-run   # signer, identity, token list, rates; no broadcast
   SEED_TOKENS=<fakeUSDC>,<fakeUSDT> bun run --cwd packages/bridge-core deploy:generation deploy --rates <abs path>/rates.json
   ```
   `--rates` is the router-only rates file (below), with an entry for every seed token and for any
   token the arc will pre-create later. Order inside one run: publish the hub and Token classes →
   **predict the factory from the signer's pending nonce** → derive the hub (`salt = Fr(factory)`) →
   deploy the factory (**it refuses to broadcast if the nonce moved**: a factory landing anywhere else
   would bind a hub nothing can reach, and the race aborts before the hub exists) → hub → readbacks
   (`factory.L2_HUB` ↔ hub; `hub.token_for(0) == 0`) → per token: `createPortal` (skipped when the
   clone exists), `register_token` on the hub only if `token_for == 0` → the router-only steps
   (swapper, rates, inventory, `DepositRouter`, readbacks; below) →
   `apps/tools/public/testnet-bridge.candidate.json`, written atomically, with the live manifest's
   `fjPerTx` and `fjRegister` carried as placeholders.
   Live, the second command is the `testnet-generation` keyed run, with `live-intent.ts verify`
   chained ahead of it inside the same `bash -c`.
   **Every step is journalled** (`packages/bridge-core/deploy-journal/testnet-generation.jsonl`,
   stamped with chain, rollup, deployer, registry and portal; a journal from another identity is
   refused): a crashed run re-runs the same command and resumes with the recorded identities, adopting
   an already-landed factory or hub instead of deriving fresh ones. Never delete the journal to start
   clean while that generation is still being deployed or may be resumed; a completed generation's
   journal is retired only when the next one starts on the same network (below).
   - **Serialize with anything else that signs from the deployer.** The nonce pin is this step's whole
     safety; a forge broadcast from the same key between prediction and deploy is exactly what the
     abort exists to catch.
   - Adding a token to a landed generation later:
     `bun run --cwd packages/bridge-core deploy:generation pre-create --token <erc20> [--no-register] [--canonical]`.
     A real token (Circle USDC, WETH) takes `--canonical`; without it the manifest labels the token a mintable
     `MintableERC20`, and the app offers a mint that reverts or mints nothing.
   - `SEED_TOKENS` are the committed test-token addresses recorded in the arc's lessons
     (`MintableERC20` deployments on Sepolia via `scripts/deploy-seed-tokens.ts`), never chosen ad hoc;
     `--dry-run` validates only their shape. Before the live run confirm each has code and answers
     `decimals()` and `maxMintPerTx()`. A real ERC-20 needs no `pre-create`: the router creates its portal inline on the first send, and the hub
     registers it on the first claim.
5. **Faucet**: `bun run --cwd apps/tools deploy:testnet` (idempotent; writes
   `src/contracts/deployments.candidate.json`, which `promote` moves into the live `deployments.json`).
   Independent accounts: runs in parallel with step 4.
6. **PrivateFPC: version gate first, then deploy.**
   `AZTEC_NODE_URL=<node> bun packages/bridge-core/scripts/check-fpc-version.ts --mode predeploy`
   (read-only, no keys; `--mode` is required, and `require-deployed` is the form to re-run before any
   funding, canary or promotion): the node's version must be in the descriptor's compatibility list
   for the artifact's sha256 (`private-fpc-canonical.json`), the descriptor must cohere, its
   `l1ChainId` and `rollupVersion` pins must match the live node (a reset reds this for identity
   reasons, and the descriptor is re-pinned with the redeploy), and a live `node_getContract` class
   check passes (an RPC error is not absence). **Canonical salt: `PRIVATE_FPC_SALT = 0x…01`, exported
   from `private-fuel.ts`; every rebuild site uses it.** Sweep for the construction pattern (`new Fr(0)`
   near FPC artifacts), not just the constant's imports. The FPC address is bytecode- and
   version-specific: **depositing Fee Juice to an address derived from the wrong version is an
   unrecoverable loss**, and a version bump is exactly what opens that window. A red gate means the
   conscious re-pin and re-canary flow (drift detector 2), not a deploy. Only on green:
   `packages/bridge-core/scripts/deploy-private-fpc-testnet.ts` (idempotent; asserts the pinned address).
7. **Candidate smokes → calibrate → promote.** The candidate's digest is recorded at the first
   `verify --candidate`, and any later change means never promote, so the candidate is final
   (calibrated) before that verify.
   - `live-intent.ts verify <intent>` (no `--candidate`) before each smoke group. Every smoke runs as
     `bun packages/bridge-core/scripts/<smoke>.ts --config apps/tools/public/testnet-bridge.candidate.json`
     and needs `PRIVATE_KEY` and `SEPOLIA_RPC_URL`.
   - `smoke-existing-testnet.ts`: registers the hub and the first two tokens (no deploy) and bridges
     each publicly and privately through `runSend` and `claimViaHub`, proving the manifest
     self-consistent and the generation able to bridge more than one token.
   - `smoke-fuel-existing-testnet.ts`: the fueled smoke, one public send whose gas slice the swapper
     turns into Fee Juice for a self-paying hub claim. Skipping it promotes an unproven fuel route.
   - `fuel-testnet.ts`: the heavy validator (public and private-FPC fuel lanes); its landed claim fees
     are the calibration input.
   - **Calibrate** (a local file transform, no keys): collect the paid claims' `transactionFee`s by
     shape (`claim_public`, `claim_private`, `transfer`, `register_and_claim_public`,
     `register_token`) into a `fees.json` array of `{shape, feeMode, transactionFee}` **written
     outside the repository** (a stray file inside it dirties the tree the next verify refuses), then
     `bun run --cwd packages/bridge-core deploy:generation calibrate --samples <absolute path>/fees.json`.
     A registering sample needs one first-time claim on a fresh test token:
     `pre-create --no-register --token <third mintable>` (its rate is in step 4's rates file), then
     `bun packages/bridge-core/scripts/fuel-testnet.ts --config apps/tools/public/testnet-bridge.candidate.json --token <third>`,
     whose claim lands as
     `register_and_claim_public` and leaves the token registered as an ordinary third token. Failing
     that, carry the sandbox's measured register excess scaled by the ratio of the two networks'
     `claim_public` samples. It writes `fjPerTx` (the worst paid plain claim) and `fjRegister` (the
     worst registering shape's excess over it), both plus 20 %; sponsored samples are excluded. A
     candidate promoted with the carried placeholders under-quotes the gas slice on the new line.
   - `live-intent.ts verify <intent> --candidate <candidate>`: records the digest (the intent file
     changes: **commit it now**, `promote` refuses an uncommitted intent), runs strict `verify-l1` and
     the hub initialization-hash readback. Then `live-intent.ts promote <intent>` (`--bridge-only`
     when the faucet candidate is not part of this arc), the only thing that touches
     `testnet-bridge.json`. Never hand-copy.
   - **On a reset, retire the old live manifest first.** `promote` refuses any network, chain,
     factory or hub move against an existing live manifest ("promotion would change the network
     identity"), and a reset moves all four. Delete `apps/tools/public/testnet-bridge.json` in its
     own commit (the path is allowlisted, so the intent stays valid), then re-run the same `promote`;
     with no live manifest it takes the first-promotion path. Never hand-edit the live manifest to
     get past the check.
8. **The live canaries** (all green is the redeploy gate):
   `bun run --cwd packages/bridge-core verify:l1 --config ../../apps/tools/public/testnet-bridge.json --strict` ·
   `BRIDGE_MANIFEST=public/testnet-bridge.json bun run --cwd apps/tools verify:deployments` ·
   `PRIVATE_RUNS=1 bun packages/bridge-core/scripts/fuel-testnet.ts --config apps/tools/public/testnet-bridge.json`
   (the private self-paying claim must settle; re-confirm the step 6 gate first, since this moves real
   Fee Juice) · **`fee-juice-canary-testnet.ts`** (the direct
   `feeJuice` lane: handler mint → `depositToAztecPublic(minFj)` → sponsored `FeeJuice.claim`, which the
   fueled smokes never exercise) · a drip (`drip-canary-testnet.ts`) · the token list against its real
   origin (`TOKEN_LIST_LIVE=1` on `packages/bridge-core/src/token-list.test.ts`: origin, schema, chain
   filter, cache; never membership).
   - **`PRIVATE_RUNS=1` is the settle canary only**: its printed `minFuelFj` is a one-sample estimate
     that may only ever raise the floor, never lower it. Size `FUEL_SLICE_UNITS` so the swapper's quote
     clears the manifest floor; a slice whose quote is under it is refused or reverts whole. The
     default slice is a quarter token: at 32 FJ per USD, 0.25 USDC buys about 8 FJ against a 29.77 FJ
     floor, and `FUEL_SLICE_UNITS=1500000` (about 48 FJ) clears it. A run with no private lane prints
     `minFuelFj` from the `actual×4` proxy (16 × a fee), not from any FPC ceiling: ignore it.
   - The private lane's ceiling is `Σ gasLimit·committedMaxFee`: every FPC self-pay claim declares
     explicit `gasLimits` (`PRIVATE_HUB_CLAIM_GAS` for the hub claim, `PRIVATE_CLAIM_GAS` for the
     direct lane). A wallet given none declares the node's per-transaction maximum (6.54M L2, about
     40 FJ on the testnet fee schedule), and the FPC then refuses any floor-sized slice with
     `Amount too low to cover gas cost`. The sandbox cannot show this; its fees make the maximum free.
   - To exercise the private first claim (`register_token` paid by the bridged fuel through the FPC,
     then the claim paid from the credit it kept) the validator needs a token the hub does not know:
     `pre-create --no-register --token <fresh mintable>` (with a swapper rate), then
     `PUBLIC_RUNS=0 PRIVATE_RUNS=1 bun packages/bridge-core/scripts/fuel-testnet.ts --config <manifest> --token <it>`.
     With the public lane on,
     `register_and_claim_public` registers the token first and the private lane degrades to a plain
     claim.
   - Never let two scripts sign from the deployer at once. To change `l1.fuel.minFuelFj`, run the
     default full calibration (`PRIVATE_RUNS` unset, three or more runs), or leave the floor alone and
     record a follow-up.
9. **Client-side reset.** The app's journal re-validates every record's token block against the live
    factory registration at boot, so a record from the old generation is withheld, never claimed
    against the new hub. The wallet's per-chain purge is the wallet's own; tell its repository the new
    generation's `tokens[].l2Token` addresses, which it mirrors (or not) as its own UI decision.
10. **CSP check.** The page connects to the node host the wallet reports and to the token list:
    `cspConnectSrc` per target lives in `apps/tools/src/lib/network-targets.ts` (the build generates
    `_headers` from it). Testnet's lists exactly `TESTNET_NODE_URL`, a path-exact source, so a moved
    node is a change to that constant; confirm the endpoint answers without a redirect (CSP stops
    path-matching after one) and that the list has exactly one entry, the file `TOKEN_LIST_URL` names.

Then Branch A's delivery gates. Live-deploy discipline: fix forward carefully, never blind-retry a
live step, and stop and surface after a few failures on one step.

**A new generation on an unchanged network** (a class id moved, the network did not). The reset
baseline stays where it is: the identity did not move, so `assertNoResetPins` passes. Two things
differ from a reset:

- The journal's identity stamp is unchanged too, so the conductor would resume the previous
  generation's journal and stop at its recorded hub class id. Confirm that journal records a
  completed generation (its last steps match the live manifest), then remove it in its own commit
  before `build`; the conductor creates a fresh one at the same path.
- The live manifest names the old hub until promotion. Retire it in its own commit after the
  candidate exists and immediately before `promote`; between those two commits the unit suite and
  the testnet build are red by construction, and nothing is validated in that interval.

**Recovery after a partial landing.** The conductor's journal is the recovery: re-run the same
`deploy` command and it skips every journalled step and adopts the two cross-bound contracts even
when their line is missing (the factory by its recorded prediction and on-chain code, the hub by
readback); each token resumes by `registrationOf` and `token_for`. The swapper and the router are
journalled only after their receipt, so a crash between landing and the append leaves a harmless
orphan the re-run replaces. **After a crash, read the journal's last line against the chain before
re-running** (`cast code`); never pass addresses by hand, never edit the journal. The live
`testnet-bridge.json` is untouched until step 7's smokes are green: **never
promote a candidate built over a partial landing**, and `live-intent verify` refuses a candidate
whose digest changed after it was recorded.

## Router-only deploy (a new router on the current generation)

When the router changes and the network does not: promotion locks the identity, factory and hub
only, so a router moves without a new generation. The candidate names the new `DepositRouter` and
`TestnetFuelSwapper` in place of the base's, and the conductor does not yet move a replaced router
into `legacyRouters` (`implementations-plan/follow-ups.md`): until it does, never replace a router
that has deposits in flight. Run from the repository root, under the deployment-intent
tooling, after the owner authorized exactly this scope (both contracts, the swapper's rates and
inventory, the named token pre-creations, the smokes and promotion).

1. **Canary key.** A live canary signs with a disposable key, never the deployer. Pin its public
   address in `PLAN_PINNED_CANARY_SIGNERS` (`live-intent.ts`) and commit it before `build`: while it
   is `null`, `verify` refuses any run with `CANARY_PRIVATE_KEY` set. The intent built after the pin
   records the canary's balance per chain, and every `verify` reconciles its spend against
   `CANARY_CAPS` (Base Sepolia 0.05 ETH, Sepolia 0.2 ETH).
2. **Rates file**, written outside the repository like `fees.json`:
   `{ "<erc20>": "<fee-asset base units per whole token>" }`, one entry for every live token and for
   every token the arc will pre-create. The conductor refuses a live token without one, and
   `verify:l1` fails a manifest token the swapper cannot price. Price like the legacy route users
   know: the 6.0.0-rc.1 testnet's last venue quoted about 32 FJ per USD (0.25 USDC ≈ 8 FJ), so
   `32000000000000000000` for a USD-pegged token and that times the ETH price for WETH. Record the
   rates in the arc's lessons.
3. **Intent.** `bun packages/bridge-core/scripts/live-intent.ts build <intent> --router-only --pre-create <erc20> …`
   (one `--pre-create` per token the arc adds), then commit it. It pins the **committed** live
   manifest's factory, implementation, registry, guardian, Permit2, FeeJuicePortal and hub (and the
   retired router and its swap target while the live manifest still names them), each live token's portal and L2 address, and the conductor journal's
   committed length. Every later `verify` refuses a journal step other than the two contracts, the
   named pre-creations, calibration and the candidate; `verify --candidate` refuses a candidate that
   moves a pinned field, drops or re-derives a live token, adds an unnamed one, or names no
   `depositRouter`.
4. **Dry run, then deploy.** L1 only (no L2 account, no proofs), so the keyed run is
   `testnet-l1.env.example`, with `live-intent.ts verify <intent>` chained ahead of it:
   ```bash
   bun run --cwd packages/bridge-core deploy:generation deploy --router-only --rates <abs path>/rates.json --dry-run
   bun run --cwd packages/bridge-core deploy:generation deploy --router-only --rates <abs path>/rates.json
   ```
   The conductor authenticates the node like `deploy`, then refuses a signer that is not the
   generation's guardian (it owns both contracts and sets the rates), a base manifest (`--config`,
   default the live one) whose registry, FeeJuicePortal, fee asset, faucet or Permit2 differs from
   the node's, and a factory not bound to the base's hub on chain. Order:
   `TestnetFuelSwapper(feeAsset, faucet, guardian)` → a rate for each token whose on-chain rate
   differs → inventory minted from the permissionless `FeeAssetHandler` up to `10 × fuel.minFuelFj`
   → `DepositRouter(Permit2, FeeJuicePortal, factory, swapper, guardian)` → readback of both → the
   candidate: the base with the new `depositRouter` and `fuelSwapper`, carrying the base's own `fuel`
   budgets (a base without them is refused).
   - **Journalled and resumable.** Both deploys append to `deploy-journal/testnet-generation.jsonl`
     (same identity stamp) with their creation-code hash and constructor arguments, sent at a pinned
     nonce. A re-run adopts a journalled contract only when both match exactly and its address has
     code; anything else deploys a new one and appends a step, so a changed router never inherits its
     predecessor's line. Rates and inventory are read before they are written, so an identical re-run
     sends nothing. A step is appended after its receipt: a crash between landing and the append
     leaves an orphan the re-run replaces, so read the journal's last line against the chain first.
5. **Pre-create** each named token into the candidate (`testnet-generation.env.example`: it
   registers on the hub): `bun run --cwd packages/bridge-core deploy:generation pre-create --token <erc20> --canonical`
   for a real token, the flag left off only for a test token with a public mint.
6. **Routing.** Re-run the conductor on the candidate with the routing file. Nothing changed, so it
   adopts both, sends nothing, and writes `routing`; every `destToken` must already be a candidate
   token:
   ```bash
   bun run --cwd packages/bridge-core deploy:generation deploy --router-only --config ../../apps/tools/public/testnet-bridge.candidate.json \
     --rates <abs path>/rates.json --routing <abs path>/routing.json
   ```
   Testnet: `{"provider":"lifi","sources":[{"chainId":84532,"rail":"acrossV4","tokens":[{"address":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","symbol":"USDC","decimals":6,"destToken":"0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"}]}]}`
   (Circle USDC, Base Sepolia → Sepolia).
7. **Verify, smoke, promote.** `bun run --cwd packages/bridge-core verify:l1 --config ../../apps/tools/public/testnet-bridge.candidate.json --strict`
   (`testnet-rpc.env.example`). Beyond the generation it checks the router's immutables
   (`SWAP_TARGET` = the swapper, `FACTORY`, `PERMIT2`, `FEE_JUICE_PORTAL`, `FEE_ASSET`, the guardian
   as owner, the app's witness type string), the swapper (fee asset, faucet, guardian as owner, a rate
   for every token; inventory under the floor is a warning), both runtimes against the forge build,
   and LI.FI's address book on Sepolia and every routing source: code at each entry and the pinned
   runtime code hashes of the Executor, receivers and fee forwarder, while a facet moved behind the
   Diamond is a warning to review. `BASE_SEPOLIA_RPC_URL` defaults to PublicNode. Then step 7 of
   Branch B: smokes, calibration (it writes `fuel`), `live-intent.ts verify <intent> --candidate`,
   commit the intent, `promote --bridge-only`.

Once deployed, `DepositRouter.sol` and `TestnetFuelSwapper.sol` are frozen: strict verification
rebuilds from source, so an edit blocks every later promotion. A change is another router-only
deploy under a new authorization.

### The testnet fuel swapper

The `DepositRouter`'s swap target off mainnet (its constructor refuses chain 1, and the manifest
refuses a `fuelSwapper` there). It answers LI.FI's `swapTokensSingleV3ERC20ToERC20` and pays the fee
asset from inventory at a fixed rate. The guardian owns it: `setRate` and `sweep` (collected input,
surplus inventory) are its only powers.

- **Rates.** `rate(token)` is fee-asset base units per whole token; zero means a fueled send of the
  token reverts. Change one by re-running `deploy --router-only` with the edited rates file (it sends
  `setRate` only where the chain differs). A token added later needs its rate before `verify:l1`
  passes.
- **Refill.** A swap short of inventory mints from the `FeeAssetHandler` itself (up to three calls,
  then it reverts), so a low balance costs gas, not a failed send. `verify:l1` warns below
  `10 × fuel.minFuelFj`; refill with a re-run of the conductor (it mints up to that floor) or
  `FeeAssetHandler.mint(<swapper>)` from any key. A network with no faucet gets an inventory-only
  swapper, funded by transfer.

### The live canary

After promotion, the matrix runs from the pinned canary key: public and private token+gas from Base Sepolia,
Ethereum-origin plain and fueled through `bridgeWithPermit`, and a forced recovery.
```bash
CANARY_PRIVATE_KEY="$(cat ~/.cache/unleashed-canary/testnet.key)" bun packages/bridge-core/scripts/lifi-canary-testnet.ts \
  --config apps/tools/public/testnet-bridge.json [--dry-run]
```
- **Testnet fills are the canary's alone.** Sepolia runs Amsterdam, where a node's gas estimate for a fill of the
  router message settles on LI.FI's recovery, and Across's testnet relayer sends 1.15 times that estimate. Its fills
  therefore pay the user's Sepolia wallet instead of depositing. Every testnet send's Across terms name the pinned
  canary signer as `exclusiveRelayer` until `fillDeadline`, and only `fill-testnet.ts` fills.
- **Fill gas.** `sendFill` sends with the smallest doubling of the estimate whose `eth_simulateV1` logs equal those
  at the EIP-7825 cap. The Sepolia RPC must answer `eth_simulateV1` with per-call gas; PublicNode does.
- **Terms.** Across's testnet API answers `AMOUNT_TOO_LOW` for the router message at 6 to 8 USDC, so rows run on
  fixed terms: a 25 % fee and a two-hour deadline.
- **Funding.** Base Sepolia: three cross-chain rows of 6 USDC, plus gas. Sepolia: each self-fill pays the row's
  output (4.5 USDC), plus the Ethereum-origin rows' 5 USDC, plus gas. Base Sepolia's USDC faucet has a two-hour
  cooldown.

## Gotchas

- **Sweep version literals across the whole workspace**: `rg -l '<old-version>' --glob '!node_modules' --glob '!bun.lock'`
  from the root, and classify every hit.
- **`test:all` passes only when its exit code is 0.** Counting `Exited with code 0` lines is not a
  pass signal; failing packages hide behind passing ones.
- **One `@aztec` generation per bundle.** Upstream's `getVKIndex`
  (`noir-protocol-circuits-types/artifacts/vks/tree.ts`) discriminates with `instanceof`, so two
  copies of that module abort with `VK index for [object Object] not found in VK tree`. A package
  that exact-pins its own `@aztec` deps must move with the line; packages that declare exact peers
  (private-fee-juice) or nothing (standards) re-bind to the workspace line and can be held.
- `aztec compile`'s "thread 'main' has overflowed its stack" can mask real type errors: run
  `aztec-nargo compile` raw, with `ulimit -s 65520`, to see them.
- `DeployMethod.send()` returns `Promise<DeployResultMined>` (no `.deployed()` chain), and a
  codegen'd `Contract.deploy` needs the `EmbeddedWallet` itself as the `Wallet` (the account object
  lacks `getContractClassMetadata`), with the account as `from`.
- A conflicting PR runs **no CI, silently** (GitHub cannot build the merge ref): check `mergeable`
  before wondering where the checks went.
- `FeeJuice.claim_and_end_setup` is only valid as the fee payload (the setup phase, where
  `FeeJuicePaymentMethodWithClaim` places it). An app-phase claim under a sponsored fee uses plain
  `claim`, or it asserts on every attempt, which looks exactly like a slow L1→L2 message sync if the
  retry loop swallows errors. Print the caught error on the retry cadence, and when a claim "never
  syncs", check the message witness (`node_getL1ToL2MessageMembershipWitness` with the key from the
  portal's deposit event) before blaming the network.
- A blanket `biome check --write` on test trees turns `vi.fn(function () {…})` mocks into arrows and
  breaks `new`-constructed mocks: format only the files you touched.
- **CI's Aztec toolchain install has no min-age gate**: `.github/actions/setup-aztec` runs the
  upstream installer, whose npm resolution is live, so an unpinned transitive published that day
  walks in (a broken `snappy` once killed every fresh sandbox boot while local runs stayed
  green on older `~/.aztec` trees). Diagnose by publish-time correlation and a bare local
  `npm install` repro before re-running CI.
- **Noir struct paths are not stable across dependency graphs.** The same `AztecAddress` parameter
  can arrive as `aztec::protocol_types::…::AztecAddress` from one compile and
  `authorization_contract::aztec::protocol_types::…::AztecAddress` from another; exact-path ABI
  matching silently finds nothing. Match suffix-tolerantly, and note that 5.x `loadContractArtifact`
  splits public functions into `artifact.nonDispatchPublicFunctions`, so probe through the package's
  own `Token.js` export, never the raw target JSON.
- **Clear `<app>/node_modules/.vite` after a dependency-line swap**, before the first browser run;
  stale optimizer caches fail with `.vite/deps/*.js does not exist`, far from the cause.
- **A replay is not the chain's trace once the chain forks ahead of foundry.** cast 1.4.1 has no `amsterdam` EVM
  version, so `cast run` replays a Sepolia fill under the old schedule. It once showed a clean deposit where the
  chain recovered to the wallet. Read the real receipt's logs first. No public Sepolia RPC serves
  `debug_traceTransaction`; `eth_simulateV1` at the parent block, varying only the call's gas, reproduces it.
- **The fuel smoke can fall under its own floor.** `smoke-fuel-existing-testnet.ts` sizes a one-token slice, which
  at 32 FJ per USD clears the 29.77 FJ floor by about 2 FJ: a raised floor or a lowered rate turns it into a
  refusal. `FUEL_SLICE_UNITS=1500000` clears it.
- **Run the unit suite after a promotion.** Tests that build candidates must read a frozen manifest
  (`packages/bridge-core/test/fixtures/`), never `apps/tools/public/*-bridge.json`, which every promotion rewrites.
