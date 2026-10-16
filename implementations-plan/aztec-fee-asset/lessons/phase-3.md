# Phase 3 — Sandbox handler and browser cells

- **I1 holds; the fallback deploy was not built.** On aztec 6.0.0-rc.3 the local network's L1 deploy creates a `FeeAssetHandler` (1000e18 per call, made a minter) whenever it deploys its own fee asset. `getNodeInfo()` reports it as `feeAssetHandlerAddress`. The sandbox now proves one mint through it, then writes it into the manifest (`feeJuice.feeAssetHandler`) and the handle (`deployment.feeAssetHandler`).
- **The handle schema strips unknown keys.** `readHandle` parses through `sandboxHandleSchema`, and zod drops undeclared `deployment` fields. On the first green-looking run, `handle.json` held the handler but `sandbox.clients.deployment` did not, so cell 47 failed in 175 ms. A field the browser fixtures read must also be declared in the schema.
- **The parked wallet frame takes real clicks on the rail.** After the Drip cards' balance reads, the wallet frame covers the Send tab, and `openSend`'s click timed out at 60 s. Cell 47 dispatches its tab switches, as the activity and registration-retry cells do.
- **Browsers on this machine.** The shell profile sets `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, which holds Chromium 1148 and 1234. Playwright 1.63.0 needs 1243, which lives in `~/.cache/ms-playwright` (CI's path too). Every cell then failed in about 4 ms at `browserType.launch`. Runs here set `PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright`.
- **Forge directories copied from the main checkout still trigger a full recompile** (94 files): the cache records the other checkout's paths. Only `lib/` saves real time.
- **Wall-clock baseline.** This session could not measure a local "before": a second worktree on `main` must be created from the canonical clone, which this session may not touch. HEAD's paste-and-Add steps in cells 18, 18b and 19 already fail by design after Phase 1. The baseline is therefore CI's: the last full `pr-tools-e2e` run, on PR #19's final head (whose cells match `main`). Its six shards' browser-suite steps took 708, 491, 1306, 555, 621 and 313 s: 3994 s in total, with shard 3 slowest at 1306 s. The "after" figure is this PR's CI run on the same six shards. The local full run is recorded below as the gate.
- **New cells, estimated → measured** (targeted runs, load average about 200): 18c 90 s → 66 s; 47 30 s → 43 s. Changed cells: 18 53 s, 18b 90 s, 19 60 s, 34 33 s.

Gate: `bun run e2e:tools` exit 0, `72 passed (1.7h)`, local wall-clock 6259 s at load average 204–220 (the rc.3 local run recorded 70 passed in 4465 s on a quieter machine).

## Codex fix loop (gpt-6.1-sol, high, session `01a145de-b810-7180-838b-8342314f8aae`)

Round 1: three material findings, three minor; all six verified against the code and fixed.
- M1 `useFeeAssetMint`: the receipt is read through the wallet's provider, so a chain switch after signing hides it, holds the shared lock through `awaitL1Receipt`'s default 8 × 90 s, and then shows the bridge journal's "Retry resumes" advice. Fix: `attempts: 2`, and a timeout names the mint's hash. The strip's manifest-token mint has the same shape and is older than this branch; it goes to follow-ups, out of scope here.
- M2 `useFeeAssetMint`: a disconnect left the in-flight `mintAmount()` read shared, so its late failure overwrote the reconnect's amount with null. Fix: a connection counter bumped on every disconnect; a superseded read writes nothing. New unit case.
- M3 cell 18c: a retry after a successful first attempt would find no "first time" notice. Fix: that check is guarded with the portal check (`retry === 0`).
- m4 card: a stale mint error hid a later connect or switch failure. Fix: the error is chosen by the current action. The unit case was extended.
- m5 cell 47: the tile only had to change. Fix: it must read exactly `formatBigInt(before + perCall, 18)`.
- m6 comments: the strip header was trimmed; `useFeeAssetMint`'s lifetime note now says only the watch stops on unmount.
- `awaitL1Receipt` already throws on a reverted receipt, so the composable's own `status !== "success"` check was dead and is gone. The unit mock now throws the way the real wait does.
