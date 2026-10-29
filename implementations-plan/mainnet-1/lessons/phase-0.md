# mainnet-1 phase 0: recon, consults and audits

## Recon

- Two Sonnet explorers: app build targets and the gas flow; Drip and the mainnet deploy surface. Their claims were
  spot-checked; one did not hold as stated: `capabilities.ts:285-309` omits the drip grants only when the caller
  passes no drip addresses, and `useWalletConnection.ts:100-114` always passes them (found by the Codex audit).
- Read-only checks on keyless public endpoints (no key): the mainnet Registry's canonical rollup, the rollup's
  bindings, `node_getNodeInfo` on `aztec-mainnet.drpc.org`, CORS preflights from the mainnet host,
  `node_getContract` / `node_getContractClass` for the Drip instances and classes, and the faucet deploy's
  `--dry-run --network mainnet` (addresses only).

## Consults

- **Dual audit, Codex** (gpt-6.1-sol, high, fresh session `01a1840c-f109-7452-8a1e-c5dbccaec8b7`): conditional
  approve, 3 High and 5 Medium. Every finding verified against the tree; dispositions in `plan.md` § Audit verdicts.
- **Dual audit, Opus 5.5 Plan agent** (fresh): conditional approve, 9 Medium and 6 Low. It found sdk-1's re-pin
  commit `45f73f6`, which made C1 a coordination ask rather than an edit here. Dispositions in `plan.md`.
- **Decision after both:** Opus's L1-scan funding ledger over Codex's numbered funding with resume by hash (no
  double payment, no crash-before-hash gap, no state); one browser cell in a1 instead of two, since sdk-1's public
  LI.FI cell moves onto the same mainnet-profile bundle; a `mainnetProfile` local-config field (new, for the final
  pass to attack) so the existing `IS_MAINNET` branches run on the sandbox.
- **Final pass, Codex** (gpt-6.1-sol, high, fresh session `01a18421-fa17-7aa0-b362-923d3e90af8f`, with the ledger
  and the five disputed or new decisions): conditional approve, 1 High, 3 Medium, 1 Low, all accepted; first resumed
  verification: conditional approve, 1 Medium, 1 Low, both accepted; second resumed verification: **approve**.
