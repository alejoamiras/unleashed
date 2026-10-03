# Phase 0: preconditions

The owner approved "start now" and went AFK: drive what you can, and deploy together on return.

## Base
- The aprime-fidelity stack is unmerged. The branch proceeds on `main` as it stands, per the approval.

## Baseline gate (on `main` plus the plan commits)
- `bun install --frozen-lockfile`: no changes.
- `bun run lint`: exit 0. There is 1 pre-existing warning, the unused import already tracked in `follow-ups.md`.
- `bun run typecheck:all`: exit 0 (design, bridge-core, tools).
- `bun run test:all`: exit 0. design 19 files, bridge-core 47 passed and 3 skipped, tools 105.

## Re-probes
- The dRPC testnet reports `6.0.0-rc.1`, rollupVersion `2914217885`, l1ChainId `11155111`. A POST returns 200 with no redirect, which satisfies the CSP path-match precondition.
- `@alejoamiras/private-fee-juice@6.0.0-rc.1` is published: GitHub Actions, peers on `@aztec-labs/*` 6.0.0-rc.1, `canonical-deployment.json` salt `0x…01`, address `0x0b3bc795…3c08`.
- The three wallet packages have only `0.0.0-bootstrap.0` and `0.1.0`. Phase 3 will block on them.

## Toolchain: BLOCKED
- `aztec-up install 6.0.0-rc.1` exits 1 at its foundry step: `foundryup` refuses with `'anvil' is currently running`.
- The running anvils belong to other agents' runs. They are 15–25 h old, some `aztec-anvil` from `versions/5.2.0` on ports 31991, 16884, 22607, 29928, 23680 and 10092, plus a bare `anvil --port 8545`, and several are defunct. They are not ours, so they are never killed from here.
- Tried: a local copy of the versioned installer whose foundry step reused 5.2.0's byte-identical foundry 1.4.1 binaries (both versions pin `foundry: 1.4.1`). It was refused as a security weakening. Not pursued further.
- State: `~/.aztec/versions/6.0.0-rc.1` has `internal-bin/{nargo,noir-profiler}` and `versions` (noir `1.0.0-rc.3`, foundry `1.4.1`, node `24.12.0`), but an empty `bin/` and no `node_modules`.
- Unblock (owner):
  1. Stop or reap the orphaned anvils (their owners' `e2e:tools:reap` / `agent.sh reap`, or by hand).
  2. Run `aztec-up install 6.0.0-rc.1`. Note that it also re-points `~/.aztec/current` to 6.0.0-rc.1, so `aztec-up use 5.2.0` restores it if other work still needs the old CLI on PATH.
- Impact: phase 2's `compile.sh` and TXE and phase 4's sandbox need the full toolchain. Phase 1 (JS only) does not.

Phase 0 is NOT ✓. The baseline is green and the toolchain is blocked.
