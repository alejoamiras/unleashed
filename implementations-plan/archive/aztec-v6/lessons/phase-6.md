# Phase 6 — Pre-deploy review, then the live generation

## Pre-deploy Codex review (GPT-6 Astra, `high`)

The scope was the phases 1–5 diff (`main..HEAD`, 34 commits), excluding `target/*.json`, lockfiles and `implementations-plan/`. The focus was the deploy path. The prompt carried the adversarial ask and both Post-implementation rules.

### Round 1 — BLOCK DEPLOY

Every finding was verified against the code before acting. All six held; #1–#4 predate this migration.

| # | Sev | Finding | Verified | Fix |
|---|---|---|---|---|
| 1 | HIGH | After `build`, only the rollup address was re-checked. `deploy-generation` took the registry from the node at deploy time, and the candidate's registry was never compared with the intent's, so a lying node could hand the factory an attacker's registry, and with it the outbox | yes: `deploy-generation.ts` read `getNodeInfo()` after creating the account; `verifyCandidate` had no registry check; `verify-l1` checks the factory against the manifest's own registry | `assertL1Pins` (all five L1 addresses) in both identity checks; `authenticatedNode()` before any account in `deploy-generation`, whose addresses come from that one probe; the candidate registry must equal the intent's and resolve on L1 to the intent's rollup |
| 2 | HIGH | The wallet store holding the derived signing keys outlives the run | yes: the SDK default is `./aztec-wallet-data` relative to the cwd and **not gitignored**; the faucet used a persistent `.tools-deploy-<net>/`; `ephemeral` tmp stores are never removed | `ownedWalletStore()` (`@unleashed/bridge-core/wallet-store`) gives each process a store under `~/.cache/unleashed`, removed on exit or a signal, for every script wallet and the faucet deploy |
| 3 | HIGH | The L1 private key went into `cast`'s argv | yes, at two sites in `live-intent.ts` | an in-process `signerOf()` via viem `privateKeyToAccount` |
| 4 | MED | `verify` and the deploy can target different endpoints | yes | Closed by #1's `authenticatedNode` in the deploy itself. A `verify`-side env comparison was rejected: each keyed run has its own env, so it would never see the deploy's override |
| 5 | MED | The Fee Juice canary checked the wrapper after the irreversible L1 deposit | yes | the check moved to right after wallet creation |
| 6 | LOW | Comments: the `PRIVATE_FPC_ADDRESS` history essay, the fixture paragraph, and `deployer-keys`' "never persisted" | yes | fixed |

Tests: `live-intent.test.ts` covers a substituted registry being refused. `wallet-store.test.ts` covers a child process's store being removed after a normal exit and after SIGTERM (exit 143).

### Round 2 — BLOCK DEPLOY (resumed session)

Codex confirmed original findings #1, #3, #5 and #6 closed, and raised three points. All three held against the code:

| # | Sev | Finding | Fix |
|---|---|---|---|
| R2-1 | HIGH | The keys still reach durable disk if the process is SIGKILLed or the host crashes, and `TOOLS_DEPLOY_DATA_DIR` bypassed cleanup | the store moves to `/dev/shm/unleashed` where present (mode 0700) and the override is removed |
| R2-2 | MED | The signal fallback cut short the sandbox's async reaper. A `once` listener is dropped before it runs, so the fallback counted only itself and exited | `prependListener`, plus a regression test that fails with `process.on` and passes with the fix |
| R2-3 | MED | The reset baseline sits in an allowlisted lessons dir, so a committed swap after the intent bypassed the drift check | `isAllowlistedPath` excludes `NO_RESET_BASELINE` |

**Lesson:** a signal fallback that defers to "anyone else listening" must be prepended. Node and Bun remove a `once` listener before calling it, so a later listener's count no longer includes it.

### Round 3 — OK WITH FIXES (resumed session)

Codex confirmed R2-2, R2-3 and the canary comment closed, and R2-1 closed on tmpfs.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R3-1 | MED | Without `/dev/shm` the store falls back to `~/.cache`, which survives a crash and a reboot; the comment said "until reboot". Codex asks for fail-closed | **Rejected (fail-closed); comment corrected**. The same helper backs the local sandbox and e2e on macOS, where fail-closed would break them. Keyed live runs happen on Linux, which has `/dev/shm`. The residual is stated in the comment |
| R3-2 | MED | A fixed `/dev/shm/unleashed` parent in a world-writable dir can be pre-planted as a symlink to disk | **Fixed.** Each store is `mkdtemp`'d directly in `/dev/shm`, with no shared parent |

**Cap reached.** Three rounds ran, and round 3 still produced material findings. Per the plan's rule this stops and goes to the owner: a fourth, confirming round must be authorized before any keyed run.

### Round 4: authorized by the owner past the cap. BLOCK, then OK (same session)

The owner authorized a fourth round ("yeah, run a 4th codex review round").

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R3-1 | — | Re-opened by the owner's round instead of rejected | **Fixed**. A store goes to `/dev/shm` only when `statfs` reports a tmpfs. Elsewhere it throws unless `allowDisk` is set, and only the sandbox harness sets it (`createL2Wallet({ sandboxKeysOnly })`) |
| R4-1 | HIGH | `deploy.ts` set `allowDisk` for `--network local-network`. The keys are still the operator's `DEPLOYER_SECRET*`, and `AZTEC_NODE_URL` can point that label at a live node | **Fixed**. The faucet deploy never falls back. I had found the same gap while the round ran |

Codex confirmed these closed: R3-2 (atomic `mkdtemp` in `/dev/shm`), the default fail-closed path, the `reapOnSignals` change (repeated SIGTERM then SIGHUP shares one stop), and the earlier rounds' registry, baseline, signer and Fee Juice fixes.

**Confirming pass: "OK … No new material findings in the reviewed deploy path."** The review has converged, so phase 6 step 1 is done.

**Operational prerequisite it raised.** The local, uncommitted `bunfig.toml` exclude fails `live-intent`'s tree discipline. Restore it (`git checkout bunfig.toml`; the patch is kept outside the tree) before `live-intent.ts build` and every keyed step. Re-apply it only for a `bun install`, until the packages are 7 days old.

## Pre-flight before the keyed arc (read-only)

- **I5: no re-seed.** The node's `feeJuiceAddress` (`0x762c…3c18`, in `reset-baseline.json`) equals the old manifest's `feeJuice.asset`. The ETH/FJ pool persists, so runbook step 7 is skipped.
- **I6 passes** (public Sepolia RPC). USDC `0x8648…51fc`, USDT `0x8bad…f38f` and the third token, EURC `0xc10b…4d24`, each has code, returns 6 from `decimals()` and `1e12` from `maxMintPerTx()`, and sorts below WETH `0xfff9…6b14`.
- **Keys arrive only as keyed runs.** Three least-privilege templates are committed against one 1Password item, `Keyed-Runs/Unleashed-Testnet`:
  - `packages/bridge-core/testnet-l1.env.example` (`PRIVATE_KEY`, `SEPOLIA_RPC_URL`): live-intent, the smokes, fuel and the canaries.
  - `packages/bridge-core/testnet-generation.env.example` (those two plus `BRIDGE_DEPLOYER_SECRET_TESTNET`): `deploy:generation` only.
  - `apps/tools/testnet-faucet.env.example` (`DEPLOYER_SECRET_KEY`, `DEPLOYER_SALT`): the faucet only.
  - `deploy-private-fpc-testnet.ts` needs no key: a throwaway account, paid by the SponsoredFPC.

## Live arc

- **Signer.** A fresh testnet L1 key was generated by `op-remote create` into `Keyed-Runs/Unleashed-Testnet` (never on this host), at `0x7F42018F47451417Fa4D39eDb6ad1e1C14C26a9a`. It is pinned, and the owner funded it with 3.0 Sepolia ETH.
- **First `build`: hard stop, nothing written.** It reported "L1 corroboration FAILED: node-claimed rollup/portal has no code". The stored `SEPOLIA_RPC_URL` was a mainnet endpoint. A keyed diagnostic that printed only the chain id and code sizes confirmed the fix once the owner corrected the field: chain 11155111, rollup 48838 and portal 3516 hex characters.
- **`build` (`intent-build-7bf0cf42`).**
  - Intent: node 6.0.0-rc.1, rollupVersion 2914217885, wallet chain 2904119610, `treeClean: true`.
  - Single L2 node (the documented residual).
  - Caps: 2.0 ETH spend and 1.5 WETH seed.

### Spend tally (signer `0x7F42…6a9a`; the baseline is the balance at `build`)

| Group | Balance after (ETH) | Spent so far (ETH) |
|---|---|---|
| baseline (`build`) | 3.0 | 0 |
| generation (`gen-deploy-8ee7a893`: verify, then deploy, 4.3 min) | 2.482638851875122309 | 0.517 |
| candidate smokes (`candidate-smokes-a81bc087`) | 2.4807890656824294 | 0.519 |
| `fuel-testnet` (`fuel-testnet-5b2c1ffb`, slice 1.5 USDC) | 2.478209607648699 (the next verify) | 0.522 |
| pre-create: EURC portal + pool, GBPC failed on L2 (`pre-create-6378de93`) | 2.225074213958726844 | 0.775 |
| pre-create GBPC (`pre-create-gbpc-21c2089f`; the next verify read it) | 1.972698318581838 | 1.027 |
| registering claims, EURC then GBPC (`register-claims-9972239f`) | 1.971379127767105410 | 1.029 |
| canaries (`canaries-02ee2fd7`) and the final verify (`final-verify-9fd7ae5c`) | 1.969826697782354686 | 1.030 |

- **Generation landed.** Guardian `0x7f42…6a9a`, factory `0x18a2…63d8`, router `0x2b76…e4aa`, hub `0x1e0b…f2fe`. USDC portal `0x4adc…7245` and USDT portal `0x764a…e563`, both registered, each with a TOKEN/WETH pool seeded (fee 3000, tickSpacing 60). L2 deployer `0x2c75…cee3`, derived from the fresh secret.
- **Forge persisted the RPC URL.** `forge script --broadcast` writes "sensitive values" to `contracts/bridge/evm/cache/<script>/<chain>/run-*.json`. Their only field is `transactions[].rpc`, here the keyed `SEPOLIA_RPC_URL`, on a shared host. All three files were deleted after the run; the conductor's journal, not forge `--resume`, is the recovery path. Follow-up: the conductor should delete that file after each successful forge script.
- **PrivateFPC gate.** `check-fpc-version --mode predeploy` is green: node, package and descriptor are all at 6.0.0-rc.1, the identity matches, and `0x0b3b…3c08` is absent (clean).
- **PrivateFPC.** Live at `0x0b3b…3c08` in 0.6 min (keyless: a throwaway account, sponsored). `require-deployed` is green, class `0x1144…51bd`.
- **Faucet (`faucet-deploy-2bb253c1`).** Its `deployments.candidate.json` is byte-identical to the committed `deployments.json`: the universal record reproduces. It is kept outside the tree, because `env-exec` refuses untracked files. Promote with `--bridge-only`; the committed record already equals it.
- **Candidate smokes.**
  - `smoke-existing`: USDC and USDT, public and private, passed in 3.2 min.
  - `smoke-swap-existing`: the fueled send into a self-paying claim passed in 1.1 min.
  - `fuel-testnet`: refused at simulation with `UniswapFuelSwap: insufficient output`, so nothing moved. Its default slice, `UNIT/4` = 0.25 USDC, quoted 8.07 FJ, under the carried floor of 29.77 FJ (`minFuelFj`). This is the runbook's documented case. The swap smoke clears the floor only because its default slice is one whole token (about 32 FJ). Re-run with `FUEL_SLICE_UNITS=1500000` (about 48 FJ).
- **`env-exec` pins the tree twice.** At filing, it refuses untracked files. At run time, it refuses them again, and it also refuses if HEAD moved since filing. So commit only between requests; one commit while the first faucet request was pending invalidated it.

- **`fuel-testnet` passed.** 4 fueled runs settled in 2.8 min (1 public, 3 private-FPC).
  - Claim fees, in FJ-wei: 2815180404621500000 (public), then 1933115518677000000, 1816088936789500000 and 1816088936789500000 (private).
  - `minFuelFj` calibration: 19672347474760000000 (4 × the worst `getFeeLimit`). The owner chose to lower the floor from the carried 29.77 FJ to this value. It goes into the candidate's `bridge.l1.swap.minFuelFj` before `verify --candidate`; syncing `MIN_FUEL_FJ` in source waits for the freeze to end.
- **Owner decision: keep GBPC.** The live manifest lists 4 tokens, so GBPC is pre-created too.
- **EURC pre-created** (`--no-register --seed-pool`): portal `0xe083…55a4`, pool seeded, added to the candidate.
- **GBPC pre-create failed on L2: `No artifact registered for contract class 0x2102… (contract 0x1e0b…f2fe)`, the hub.**
  - Cause: a regression from the per-run wallet stores. `pre-create` used to reuse the shared, in-tree `./aztec-wallet-data`, which remembered the hub from the `deploy` run. Now the wallet is fresh, and `preCreateToken` registers the Token instance but never the hub before `registerOnHub` reads `token_for`. EURC passed only because `--no-register` skips that call.
  - A source fix mid-arc would trip `assertNoSourceDrift` and force a rebuilt intent. So GBPC is re-run with `--no-register` (it adopts its portal), and EURC and GBPC are registered by their first public fueled claim, which also gives two `register_and_claim_public` calibration samples.
  - The fix (register the hub instance from the manifest, with a test) lands after the final verify, in this PR.
- Forge wrote the RPC-bearing cache files again (EURC's pool seed); deleted.

- **GBPC pre-created** (`pre-create-gbpc-21c2089f`, `--no-register --seed-pool`): portal `0xc9f5…d413`, pool seeded. The candidate now lists USDC, USDT, EURC and GBPC, as the live manifest does.
- **Registering claims.** The first public fueled claims for EURC and GBPC each landed as `register+claim`, 5136803262292800000 FJ-wei (about 2.38M L2 gas). Both tokens are registered on the hub.
  - Their printed `minFuelFj` (82.19 FJ) is the no-FPC fallback, 16 × the actual fee, and not a floor measurement; it was ignored.
- **Calibrate** (`fees.json` kept outside the repository): 1 `claim_public`, 3 `claim_private` (`private-fpc`) and 2 `register_and_claim_public` samples. `fjPerTx` 3577823745897251607 → **3378216485545800000**; `fjRegister` 1967429819850912960 → **2785947429205560000**.
- **Floor: kept at 29.77 FJ.** The owner first chose 19.67 FJ, then revised that once told the value covers only plain private claims (4 × a 4.9 FJ ceiling). A private first claim on an unregistered token pays `register_token` plus the claim through the FPC. That is estimated at about 10.7 FJ (moderate confidence: scaled from measured gas, never run on testnet), so 19.67 would leave about 1.8× margin against about 2.8× now. The candidate's `minFuelFj` stays 29773418555864000000, and `MIN_FUEL_FJ` in source needs no change. Follow-up: measure the private first-claim path on testnet (`PUBLIC_RUNS=0 PRIVATE_RUNS=1 fuel-testnet --token <fresh>`).

- **`verify --candidate` (`verify-candidate-5c9781c9`) passed.** Strict `verify-l1` covered code, the cross-bindings, 4 portals and their registrations, and the masked runtime hashes. The privileged readbacks agree. `candidateSha256` `345f68c0…c76f` was committed.
- **First `promote` stopped before any write: "promotion would change the network identity (walletChainId 1816023401 → 2904119610)".**
  - `assertZeroSeed` (`src/promotion.ts`) refuses any network, chain, factory or hub move against a live manifest, and a reset moves all of them.
  - The interlock postdates the last reset arc, so the runbook had no path. It skips only when no live manifest exists (the "first promotion" path).
  - **Owner decision:** retire the old v5 manifest (`walletChainId` 1816023401, factory `0xcb00…5edc`) in a commit of its own. It is allowlisted, so there is no source drift and no intent rebuild. Then re-run the same `promote --bridge-only`.
  - Follow-up: give `promote` an explicit reset mode that allows the move only toward the intent's own identity, and document it in Branch B.
