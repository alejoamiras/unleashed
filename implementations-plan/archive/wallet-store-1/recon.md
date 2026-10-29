# wallet-store-1: recon

Base: `main` 2aaec3a. One Sonnet Explore agent (reuse sweep, eight capabilities) plus the planner's Bun 1.4.2 probes on
this host. Read-only; no `.env` file opened.

## Reuse map

| Capability | Existing code | Verdict |
|---|---|---|
| Store creation, exit and signal removal | `packages/bridge-core/scripts/wallet-store.ts` (`storeRoot`, `freshDir`, `ownedWalletStore`) | adapt: pid in the name, reap before `mkdtemp` |
| Pid liveness | none. Searched `process\.kill\(`, `ESRCH`, `EPERM` over `*.ts`, `*.mjs`, `*.js`, `*.sh`. Nearest: `sandbox/local-network.ts:370-385` (`killGroup`, signals only); `apps/tools/scripts/e2e/agent.sh:24` (`kill -0` plus a `ps` name check against pid reuse) | build new: one `kill(pid, 0)` helper; ESRCH alone means dead |
| Reading `/proc` | only `/proc/sys/net/ipv4/ip_local_port_range` (`local-network.ts:55`, `apps/tools/scripts/e2e/resolve-ports.ts:23`). Searched `/proc/`, `readlink` | build new: fd and cwd scan |
| Dead-owner reaping | `agent.sh:18-40` reaps sandbox pid files when the group is gone (shell). `~/.agents/ports.md` rows carry a `pid-hint` that nothing checks (`local-network.ts:126-230`) | build new; same rule as `agent.sh`: a live pid keeps the artifact |
| Symlink- and owner-checked removal | `live-intent.ts:1061-1076` refuses a symlink by `lstatSync` before a rename. No `getuid` or uid comparison exists. Searched `lstat`, `isSymbolicLink`, `getuid`, `\.uid\b` | adapt the `lstat` idiom; build the uid check |
| Child-process tests | `wallet-store.test.ts:11-24` (`child`, `storeOf`: `bun -e`, prints the store path); `run.test.ts:53` (a child that SIGKILLs itself) | reuse `child` and `storeOf` as they are |

## Facts

1. Creators of `unleashed-*` stores: `script-bootstrap.ts:89` (`createL2Wallet`, label `wallet`),
   `apps/tools/scripts/deploy.ts:144` (label `tools-deploy-<network>`), `wallet-store.test.ts:13` (label `test`).
   `drip-canary-testnet.ts:167` makes its own `drip-canary-*` store in `~/.cache/unleashed`, outside this helper.
   No other code makes `unleashed-*` directories.
2. The store is opened in the process that calls the helper. `EmbeddedWallet.create` calls `createPXE` and
   `openStore` (`@aztec-labs/wallets/dest/embedded/entrypoints/node.js:55-62`). Those reach `NativeLMDBStore`
   (`kv-store/dest/lmdb-v2/store.js:32`), a NAPI addon loaded with `require` (`@aztec-labs/native/dest/native_module.js:9`).
   No worker or child process is involved, so the creating pid holds the LMDB fds and maps.
3. Store layout: `<store>/{pxe_data,wallet_data}-stores/<chain>-<addr>-v<N>/{data.mdb,lock.mdb}`. The top
   directory is 0700, the inner ones 0775. A sandbox store holds about 18 MB.
4. Bun 1.4.2 probes: `mkdtempSync` creates 0700. `rmSync(p, { recursive: true, force: true })` unlinks a nested
   symlink without following it, and on a top-level symlink it removes only the link. `process.kill(1, 0)` throws
   EPERM; `process.kill(999999999, 0)` throws ESRCH. `Bun.mmap(file)` leaves one line in `/proc/self/maps` and no
   fd on the file.
5. `/proc` on this host: `/proc/1/fd` is EACCES (another uid). A scan of every visible process reads 127 processes
   and 1025 fd links in 12.5 ms, with 17 denied; reading every `maps` file takes 19 ms more. Two denied processes
   belong to this uid: `(sd-pam)` (non-dumpable, lives all session) and a zombie `bb` whose parent `bun test` has
   run for 35 days.
6. `/dev/shm` here is a 2 GB tmpfs, mode 1777 (sticky), owned by root. It is 99% full: 110 `unleashed-wallet-XXXXXX`
   stores and 67 `bb-sync-*` request/response pairs, all owned by this uid. `pid_max` is 4194304. The disk root
   `~/.cache/unleashed` is 0775 (its parent `~/.cache` is 0700); `mkdirSync`'s mode applies only on creation.
7. `packages/bridge-core/vitest.config.ts` runs `scripts/*.test.ts` under `bun --bun vitest run` with the default
   5 s test timeout, and sets no pool. A timed-out test does not kill its `bun -e` children.
8. Biome: cognitive complexity ≤ 15 and ≤ 80 non-blank lines per production function (`biome.json`).
9. Closed known limits: the only one is #38 (relayer faucet), which is unrelated. No open issue overlaps #52.

## Collision risks

- The old names (`unleashed-<label>-XXXXXX`) carry no pid. A reaper that guessed liveness for them would race the
  window between `mkdtemp` and the moment LMDB opens its files, when nothing holds the store yet.
- The tests' stores land in the real `/dev/shm` on Linux (`storeRoot({ allowDisk: true })` returns `/dev/shm` on a
  tmpfs host). An end-to-end reap test therefore also reaps other runs' dead stores on the same host. That is the
  intended behaviour, not a test leak.
