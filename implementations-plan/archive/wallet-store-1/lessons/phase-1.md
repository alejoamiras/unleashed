# wallet-store-1: phase 1

- Implemented as planned in `wallet-store.ts` (`reapDeadStores`, `deadStores`, `heldPaths`, `isGuarded`, `isDead`,
  `attempt`) and `wallet-store.test.ts`. The plan's per-test `finally` became one `afterEach` that sends SIGTERM to
  every child still running and awaits it: SIGTERM, not SIGKILL, so the cleanup itself leaks no store. `exited` now
  settles on `close`, after the child's stdout ends, so `firstLine` can tell "no line yet" from "never printed".
- Runtimes (Bun 1.4.2, this host, loaded): T1 100 ms, T2 96 ms; the whole file 480 ms of tests.
- Mutation checks, each restored after: `reapDeadStores` returning at once fails T1 and T2; dropping the `maps` scan,
  the cwd link or the root guard each fails T2.
- Gate: `bun run lint` 0 (two `noDelete` infos in files this arc does not touch); `bun run typecheck:all` 0;
  `wallet-store.test.ts` 7/7; `bun run test:all` 0 (no SIGBUS this run); `bun run audit:tools` 0.
- Determinism: the test file passed 8 times in a row, and 3 times as two concurrent runs (another worktree's reap
  racing T1); no `unleashed-<pid>-*` entry was left in `/dev/shm` afterwards. Bun throws `ERR_INVALID_ARG_TYPE`
  for a pid above 2^31-1, so a crafted huge pid reads as alive and keeps its entry.

## Fix loop round 1 (Codex, new session): 1 finding

Low: a failing T1 leaked the killed child's store (SIGKILL skips its exit removal, and `afterEach` only stops live
children). Fixed with a `finally` that removes it (d4441fb).

## Same-family review (Opus, alongside round 1): 5 Lows, all adopted

1. The doc comment promised a reap "by the next call on the host"; the disk root here is 0775 and fails the guard.
   Reworded to point at `reapDeadStores`'s limits.
2. T1 fails on a Linux host without a tmpfs `/dev/shm` (its stores go to a disk root the guard may refuse): T1 now
   runs only where stores go to `/dev/shm`, which is known limit 1, not a dodge.
3. On overlayfs before Linux 6.8, `maps` names the backing file, so T2's mapping holder reads as unheld: T2's root
   now lives in `/dev/shm` when it is a tmpfs. Production is unaffected (stores live on tmpfs; LMDB also holds an fd).
4. No test pinned the sticky branch's owner check: `isGuarded` is exported and a six-row table test pins it
   (mutations `return true` on a sticky root and `0o002` for `0o022` each fail it).
5. T1's `finally` could throw EPERM if another uid took the freed name: the removal there ignores errors.
