# Phase 4 — Sandbox rehearsal and browser e2e

## Sandbox smoke (`deploy:sandbox --smoke`, 6.0.0-rc.1 local network)

**Run 1, red at step (e) "private exit paid across three credit notes".** The error was `at the ceiling 21878792600000 pay_fee selects 2 note(s), not 3; the fixture lost its shape`.
- The first credit note was minted at 1.4× a ceiling of 29.17e12. By the first exit the ceiling had fallen to 21.88e12, as v6 fee prices dropped over the network's first blocks.
- Its change was therefore ≈0.87× the ceiling, not the ≈0.4× the fixture assumed. With the two 0.45× notes, a pair covered the ceiling.
- The send-time shape check caught it before anything was spent.

**Fix (before the rebase).** `flowPrivateGasFragmented` sizes the two equal fragment notes `x` from the change `r` actually held at the current ceiling `C`:
- Three notes must cover: `x ≥ (C − r)/2`.
- No pair may cover: `x < C − r` and `2x < C`.
- `x` takes the middle of that window, and the shape is asserted at mint time as well as at send time.

**Run 2, green.** All 31 steps passed in 10.4 min (`✅ sandbox deploy + smoke OK`), with the PrivateFPC and the real `register_*` publications. Key output:
- Calibration over 9 paid claims: `fjPerTx=21622025280000`, `fjRegister=8106768240000`.
- The private exit spending one note billed `l2Gas=826648`, `daGas=1696` (5 nullifiers).
- The exit spending three notes billed `l2Gas=888248`, `daGas=1760` (7 nullifiers).
- In both, the landed fee equals the simulated gas at the block's prices, and the credit charged is the ceiling, 21878792600000.

**I4 resolved.** `aztec start --local-network` from `~/.aztec/versions/6.0.0-rc.1` accepts every flag `local-network.ts` passes, and the network served the whole smoke.

**Reaped.** After exit, `pgrep -af "anvil|aztec start|local-network"` is empty.

**Fixture.** `packages/bridge-core/fixtures/sandbox-manifest.json` is now the run's `sandbox-deploy/manifest.json` (before the rebase). The bridge-generation, useTokenSelection, useTokenCatalog, useSend and manifest-v2.fixture tests pass on it.

## Rebase onto `main` (aprime-fidelity merged)

- Conflicts:
  - `implementations-plan/index.md`: took this plan's line.
  - `TokenCard.vue` and `spike.spec.ts`: kept main's side and re-applied the scope mapping.
  - `noir-artifact-classids.test.ts`: kept main's comment and moved the version text to 6.0.0-rc.1.
- Post-rebase checks:
  - The scope scan shows only the known non-import hits: forge remap aliases in `gen-remappings.ts` and the guard's own strings.
  - `bun install --frozen-lockfile` reports no changes. `typecheck:all` and `lint` exit 0. `test:ci-gating` passes 35/35.
  - `test:all` fails exactly the expected set: the `bridge-generation.test.ts` testnet manifest test and `deployments-records.test.ts` (4 tests), which wait on the phase 6 deploy.

## Browser e2e

**Run 1 stopped in global setup, before any spec ran.** The error was `the sandbox's deployments.json differs from apps/tools/src/contracts/deployments.json — the drip record is no longer universal`.
- The faucet record (Dripper plus two tokens: deployer zero, fixed salts) depends only on class ids, which v6 moved.
- Only the three addresses differ, and both sandbox deploys (the smoke and this run) produced the identical record.
- The plan had put this file in phase 6's generated set. The suite needs it at phase 4, and because it is chain-independent the testnet faucet deploy must reproduce it byte-for-byte. So it is committed now, and phase 6 checks that the candidate equals it.
- With it in place, `deployments-records.test.ts` passes 6/6 and `verify:deployments` re-derives every address. The expected-red set shrinks to the testnet manifest test alone.

## Integration (`bun run --cwd packages/bridge-core test:integration`)

- **Run 1:** 34/35. Cell 28 failed on its report string only: the fixture rewrite had dropped the phrase `none covers a ceiling`, which `exits.integration.test.ts` asserts. The flow itself had placed three equal notes at 0.4× the ceiling. Fixed in the report text.
- **Re-runs:** the exits file alone passed 5/5, then the full suite passed **6 files, 35/35, exit 0**. Each run boots and reaps its own sandbox.

## Leaked anvils after the e2e runs (root-caused, fixed)

Both e2e runs left their anvil behind (PPID 1, its own group), plus four port-registry rows and an empty data dir each. The node had died, and each `sandbox.log` ended with `error: script "sandbox:up" was terminated by signal SIGTERM`, so the sandbox's own reaper never finished.

- **Mechanism.**
  - `agent.sh` sends SIGTERM to the sandbox's group, and `bun run` forwards a second one to its child.
  - The reaper was registered with `process.once`, so the first signal consumed it.
  - The second signal found only `signal-exit@3.0.7`, which `proper-lockfile` loads at import. It unloads and re-raises when its own listeners are the only ones left.
  - The process died by signal and skipped the synchronous `exit` reap. The node died on its broken stdout pipe, but anvil runs `--silent` and never writes, so it lived on.
- **Reproduced** with a probe that boots only anvil and the node and is torn down exactly as `agent.sh` does it. With main's listener set it printed `terminated by signal SIGTERM` and leaked its anvil. With the fix it exits 130 and the anvil is gone.
- **Fix.** `reapOnSignals` registers with `on`. `stop()` was already idempotent, so a second signal re-awaits the same stop. Its test emits SIGTERM in a child process and asserts the reaper is still registered; it fails on `once`.
- **Not the wallet store.** Both sandboxes booted before the wallet-store commits. Its prepended fallback happens to absorb the second signal too: the count it sees includes `signal-exit`. The reaper must not depend on that.
- **Reaped by exact PID** (owners verified dead): the two anvils from the e2e runs and one from the probe. Their 12 registry rows were released with `releaseHostPorts` and the three empty data dirs removed.

## Gate re-run on the fixed tree

These ran after the reaper fix and the wallet-store changes, each separately:

| Command | Result |
|---|---|
| `bun run --cwd packages/bridge-core deploy:sandbox --smoke` | 31/31 steps, `✅ sandbox deploy + smoke OK (10.8m)`, exit 0. Calibration is unchanged (`fjPerTx=21622025280000`, `fjRegister=8106768240000`) |
| `rm -rf apps/tools/node_modules/.vite && bun run e2e:tools` | **70 passed (1.3h)**, playwright exit 0 |
| `bun run --cwd packages/bridge-core test:integration` | 6 files, **35/35**, exit 0 (1253 s) |
| reaped by owned pgid | The e2e sandbox ended with `script "sandbox:up" exited with code 130`, not "terminated by signal". No registry rows, no anvil or node, and no data dir are left. The integration run and the smoke are reaped too |
