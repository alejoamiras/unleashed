# Phase 9: review, run, close-out

## The scripted run

Claimed a port with `resolve-ports.ts` (run id `terms-1-gate`) and started the mainnet dev server in
its own process group. A throwaway Playwright script (not committed) defined `window.ethereum` through
`addInitScript`, which answered from Node through `exposeFunction` using two viem accounts: one signs,
the other stands in as "another account" for the failed state. It ran every flow at 1280 and 390 px, in
light and dark: 56 checks passed, with no console errors.

- First visit: the gate, no wallet request before the press, focus on the heading.
- Refused, busy (`-32002`), failed (a signature from another account) and pending (a request that never
  answers) each show their own line.
- Keyboard only: three Tabs from the heading reach the button; Enter on a refusal leaves focus on the
  button; Enter again accepts.
- A reload keeps the acceptance and prompts nothing. A changed stored digest shows the re-ask; empty
  storage shows the gate; a browser with no injected wallet shows the no-wallet line.

Shots of all eight states in the four combinations were compared with the signed mocks. The server was
then stopped by its process group and the port released with `--release`.

## `e2e:tools` ran in CI only

The sandbox suite deploys the EVM bridge, whose tests need `contracts/bridge/evm/lib/lifi-contracts`.
Neither this worktree nor the canonical clone has it, and the README's install sequence ends in a
cleanup step this lane may not run. As in P5, CI's `tools-e2e-status` is that layer. `App.vue` is the
only shared file that changed, and the testnet dist is byte-identical (phase 8).

## Commit signing

A signed `git commit` hung waiting for the SSH agent. `env -u SSH_AUTH_SOCK git commit`, under a
bounded `timeout`, signed with the file key.
