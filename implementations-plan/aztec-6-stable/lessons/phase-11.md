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
