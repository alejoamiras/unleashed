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
