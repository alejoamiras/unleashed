# Phase 11: docs and the final gates

## Docs

- The runbook names this plan as the latest worked example and gains three lessons: the sandbox anvil's 7-wei
  base fee, a calibration that reproduced rc.3's fees to the wei, and checking the preview only after promotion
  (`8d7ad60`).
- `follow-ups.md`: the 6.0.0-generation entry is deleted, `lifi-routing` rebases onto 6.0.0 and names this
  generation's factory, the withheld rc.3 records join the rc.1 and v5 entries, and the `MIN_FUEL_FJ` entry notes
  that 6.0.0 measured the same ceilings.
- `UPDATE.md` already read true for 6.0.0 and the Nulo `0.3.0` pins. `AGENTS.md`'s Nulo table names no version
  or address, so none of its four facts changed in wording.

## The final Codex pass

Fresh session `01a16e52-7266-7531-9694-4a3bdde1970e` (`gpt-6.1-sol`, high) over the PR's net diff, asking for
drift from the plan and seams across the live window. Verdict: "One medium retry hazard and two low documentation
issues; no demonstrated key leak or manifest inconsistency (high confidence)." It re-derived the faucet, hub and
token addresses, checked the manifest, receipt, intent and journal against each other, and ran the line,
published-peer and committed-key checks (10 passed).

| Finding | Disposition |
|---|---|
| Medium: `keyed/step3-deploy.sh` retried any failure, and `deploySwapTarget` (like the router) journals only after its receipt read, so a failed read after a landed broadcast would deploy a second contract on retry | Accepted. Verified in `deploy-generation.ts`. The retry now fires only on the runbook's two lag signatures (`returned no data`, `landed but the factory has no registration`) and stops on anything else; a stub run proved both paths. The live run needed no retry, so nothing deployed is affected; the script as it ran is at `a8d57d9` |
| Low: the runbook called the anvil base fee "fixed"; the flag sets the start, and full blocks can raise it | Accepted: "starts at a 7-wei L1 base fee, where an under-target block's EIP-1559 decrease rounds to zero" |
| Low: the `keyed/` script headers cite phases and narrate their steps | Declined: they are this plan's own record and are archived with it; the no-workflow-references rule is for code that outlives a plan |

Round 2 (same session) confirmed the retry's control flow and the decline, and found one more medium: the
fix's `grep … <<< "$out"` hands the captured output to a here-string, which Bash spills to a temp file once it
passes the pipe buffer, and `/tmp` on this host is overlayfs, not tmpfs, so a keyed URL in a failed deploy's
output could reach disk unmasked. Codex reproduced the spill with a harmless 20,000-character string. Accepted:
the match is now a shell `case`, and the stub run passes both paths again. The live run used the earlier
blanket retry, which captured nothing, so no spill happened.

Round 3: "No new material finding (high confidence within the reviewed helpers)." Secret values reach only the
stash, its runtime-dir precursor, the chosen command's environment and the masker's; the masker's argv carries
names; nothing else writes captured output to a file, an external pipe or argv. Its stated limit: this covers the
`keyed/` helpers, not every file the invoked tools write (forge's broadcast cache, which no step here produced).
The pass converged.


## The final local gate

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | 0 |
| `bun run lint` | 0 |
| `bun run typecheck:all` | 0 |
| `bun run test:all` | 0: tools 1681, bridge-core 490 (1 skipped), design 242, landing 76 |
| `bun run test:ci-gating` | 1, then 0 (37 pass): the runbook linked the plan at its archive path before the move. It points at the active path until the archive commit re-points it |
| `bun run audit:tools` | 0 |
| `bun run lint:actions` | 0 |
| `bun audit` | 1, advisory: 71 (34 high, 30 moderate, 7 low) against Phase 2's 70. The one new id is undici `GHSA-xjj6-f33q-929c` (`<7.30.1`), published since against the same lockfile |
| both builds with `verify:build-target` | 0 |
| `bun run build:landing` | 0 |
| `e2e:tools` | 73 passed in 6087 s, no retries. Phase 7 recorded 73 in 5830 s; the rc.3 baseline was 70 in 4465 s |
