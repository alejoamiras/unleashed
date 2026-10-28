# Phase 0: planning consults

Every consult of the planning run, in order. Codex ran `gpt-6.1-sol` at `high` through `run-codex.sh` (this host's
sandbox mode is the opt-in `approve-for-me`; the prompts forbade writes). Opus 5.5 ran as `Plan` agents.

| # | Who | Session | Ask | Verdict | Disposition |
|---|---|---|---|---|---|
| 1 | Sonnet Explore ×3 | recon | bridge-core export map; app flows and step model; the fuel-only mainnet path | facts | `recon.md` |
| 2 | Codex | drafting session, fresh | independent plan draft | draft (518 lines) | consolidated; ledger D1–D16 names what came from it |
| 3 | Opus 5.5 | drafting agent, fresh | independent plan draft | draft | consolidated; ledger D1–D16 |
| 4 | Codex | drafting session, resumed | contradiction check | reject pending 8 corrections | all 8 accepted (D19–D21, 1.3, 2.4, 3.1, data flow step 6) |
| 5 | Opus 5.5 | drafting agent, resumed | contradiction check | holds after fixes (10) | all 10 accepted (D9, D10, D17, D18, 1.2, 2.1, 2.3, `OWNER-ASKS.md` §1, §3) |
| 6 | Codex | drafting session, resumed | double audit | reject (2 High, 4 Medium) | all 6 accepted (D11, D22, Dependencies, 2.4, 3.1, `capabilitiesFor`) |
| 7 | Opus 5.5 | `Plan` agent, fresh | double audit | conditional approve (1 High, 4 Medium, 5 Low) | all 10 accepted (D11, D22, D23, D24, 1.1, 1.2, 2.2, 2.4, data flow step 3, Dependencies) |
| 8 | Codex | new session | final fresh pass | reject (1 High, 1 Medium, 1 Low) | all 3 accepted (D11 registry and Outbox anchors, D25 `resolveToken`, 3.2 paired builds) |
| 9 | Codex | final session, resumed | verification of row 8's fixes | approve | none open |

## Notes

- The recon claim that ask5's flow (1) is the direct-portal planners in `fuel.ts` did not hold: no app code calls them;
  flow (1) is the router's identity route (Opus draft). Flows (1) and (3) became one fuel entry.
- `implementations-plan/follow-ups.md`'s "One fork test for Ethereum-origin sends through real LI.FI" is stale:
  `LifiDestinationFork.t.sol:291, :308` already exist (Codex draft; verified).
- The first consolidation misread `PortalFactory` as `Ownable`; it is `Ownable2Step` (`PortalFactory.sol:24`).
- Two orchestrator notes arrived during the contradiction check: relayer-1's bridge-core seam and its Worker-safe fill
  core; the plan keeps both in bridge-core and gates a2 on the relayer workspace.
- The double audit's central finding: a code-hash check compared with the manifest's own addresses proves nothing about
  a genuine router deployed on an attacker's Permit2 or portal. Trust roots must come from outside the manifest (D11).
- The publish workflow first ran build, tests and pack in the job holding `id-token: write`; every dev dependency would
  have run beside the OIDC token (D22).
- The final pass found what two rounds missed: `PortalFactory` and `TokenPortalImpl` freeze their Inbox and Outbox from
  a constructor registry, so a code-hash check passes a genuine factory built on a hostile registry. Anchor the
  registry itself to the node's `registryAddress`.
