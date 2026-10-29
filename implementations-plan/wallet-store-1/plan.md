---
plan: wallet-store-1
tier: light
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: approved by the final Codex pass; awaiting the orchestrator
base: main 2aaec3a
budget: "recon: 1 Sonnet explorer; code-review: off; Codex gpt-6.1-sol at high"
---

# wallet-store-1: reap the wallet stores a killed run leaves

## Summary

Each store that `ownedWalletStore` makes carries its creator's pid in its name. Before it makes a store, the helper
removes the stores whose creator is dead. It removes only a directory this uid owns, never through a symlink, never
while the named pid is alive, and never while a live process it can inspect holds the store.

**Requirements.** #52 → a1 (`Closes #52`). Asks: none. **UI impact.** Recorded owner decisions: "(none: no visible
change)". No product surface changes; scripts and tests print nothing new.

## Outcome & Quality Bar

**For whom.** The agents and the owner who share one development host. Their tests and scripts make wallet stores
in `/dev/shm`, and a runner's timeout or a process-group reap ends some runs with SIGKILL.

**Excellent.** (1) A store that a SIGKILLed run left goes away at the next store creation on the host. A store that a
live run uses (its creator alive, or a readable process holding it), or that another uid owns, is never touched,
and no planted name makes the reap delete anything else.
(2) The reap never makes a store creation fail, and costs one directory listing when no creator is dead.

**Good enough.** Stores from before this change carry no pid and stay; the owner clears them once. Hosts without
`/proc` (macOS, where sandbox stores fall back to disk) do not reap.

## Assumptions

### Facts (verified at 2aaec3a; trails in `recon.md`)

1. Three code paths make `unleashed-*` stores, all through `ownedWalletStore`: `script-bootstrap.ts:89`,
   `apps/tools/scripts/deploy.ts:144`, `wallet-store.test.ts:13`. Nothing else makes them (recon fact 1).
2. The calling process opens the store: LMDB runs in a NAPI addon in that process, with no worker or child process
   (recon fact 2). So the creating pid is the right owner. Each store path is a fresh `mkdtemp` name; another
   uid can list it in `/dev/shm` but cannot enter the 0700 store.
3. Bun 1.4.2: `mkdtempSync` makes the store 0700. Recursive `rmSync` removes a symlink, nested or top-level, and
   never follows it. `kill(pid, 0)` throws ESRCH only for a pid that does not exist, and EPERM for another uid's live
   pid. `Bun.mmap` leaves a mapping in `/proc/self/maps` with no fd (recon fact 4; planner probe).
4. `/proc/<pid>/{fd,cwd,maps}` is unreadable (EACCES) for another uid's process, a zombie, and a non-dumpable
   process. This host has two of this uid: `(sd-pam)` and a zombie `bb`. A full fd scan takes about 12 ms, `maps`
   about 19 ms more (recon fact 5).
5. `/dev/shm` is mode 1777 (sticky) and owned by root, so another uid cannot rename or delete this uid's entries
   (recon fact 6). The disk root `~/.cache/unleashed` is 0775 here: `mkdirSync`'s mode applies only when it creates
   the directory. Its parent `~/.cache` is 0700.
6. The old names `unleashed-<label>-XXXXXX` have a label of letters and dashes after `unleashed-` (`wallet`, `test`,
   `tools-deploy-<network>`), never a digit (fact 1).

### Inferences

- I1: no code opens another process's store by path (fact 2). A holder other than the creator is a process that
  inherited an fd or a mapping from a live holder, or a person in a shell. Such a holder exists at the scan, so the
  scan sees it if it is readable.
- I2: no process that holds a wallet store is non-dumpable. Bun does not mark itself non-dumpable, and the
  non-dumpable processes of this uid (`sd-pam`, ssh and gpg agents) never open one. A zombie holds no file.

### Asks (working assumption in force)

- none.

## Architecture & Implementation

All of it is in `packages/bridge-core/scripts/wallet-store.ts`. No new module and no dependency.

```ts
/**
 * Removes each `unleashed-<pid>-*` directory in `root` whose pid is dead, which this uid owns (by lstat, so never a
 * symlink), and which no readable live process holds by an fd, its cwd or a mapping. Never throws; removes nothing
 * where `/proc` cannot be listed or another uid can rename entries in `root`.
 */
export function reapDeadStores(root: string): void
```

- **Name.** `freshDir` makes `unleashed-<pid>-<label>-XXXXXX`. The pid comes first, so the parse is a prefix match:
  `/^unleashed-([1-9]\d*)-/`. Old names never match (fact 6).
- **Order.** `ownedWalletStore` resolves the root, calls `reapDeadStores(root)`, then makes its own store, on every
  call. A store creation is rare, and the reap lists `root` once when no creator is dead.
- **Steps.**
  1. Resolve `root` with `realpathSync` and stat the result. Go on only if root (uid 0) or this uid owns it and it
     is sticky, or this uid owns it and no group or other can write it. A sticky directory's owner may rename any
     entry in it, so another owner fails. On this host `/dev/shm` passes and the 0775 disk root does not; `root`
     keeps its mode. Every later path joins the real root.
  2. List `root`. Keep the names that match. Keep an entry whose pid is dead: `kill(pid, 0)` throws ESRCH. Any other
     result, success and EPERM included, means alive.
  3. `lstat` each entry. Keep it only if it is a directory and its uid is `process.getuid()`.
  4. If none is left, return; this is the common path. Otherwise read, once, every `/proc/<n>/fd/*` link, every
     `/proc/<n>/cwd` link and every path in `/proc/<n>/maps`: the rest of the line after its five fixed fields,
     spaces kept. Skip a process whose files cannot be read (fact 4, I2).
     If `/proc` itself cannot be listed, return.
  5. Remove each entry that no path names (the entry's real path, or a path below it), with
     `rmSync(path, { recursive: true, force: true })`. Ignore an error from one removal, then go to the next.
- **Paths.** `/proc` shows real paths, hence the real root of step 1. A store path never holds a newline, which
  `maps` would escape.
- **Shape.** Small functions (`isDead`, `deadCandidates`, `heldPaths`, `reapDeadStores`), each under Biome's limits.
  The module doc comment loses "a SIGKILL or a crash leaves a tmpfs store until reboot" and states the reap.
- **Not taken:** the decision ledger.

## Security & Adversarial Considerations

- **Threat model.** Another local uid can make any name in `/dev/shm`: a directory, a file or a symlink, aimed at
  this user's files. It can run processes. It cannot read inside a 0700 store, and the sticky bit stops it from
  renaming or deleting this uid's entries. Same-uid processes are trusted.
- **Planted symlink.** `lstat` sees a link, not a directory, so the entry is skipped. A swap after the check needs a
  rename of this uid's entry, which step 1 makes impossible for another uid. The guard checks the root, not its
  ancestors: store creation already trusts the root's path, and a uid that owns an ancestor could redirect it.
  `rmSync` also removes a link, nested or top-level, without following it (fact 3).
- **A store another uid owns.** It fails the uid check, so the reap never removes it.
- **A live process that holds a store.** The fd, cwd and `maps` scan keeps the store. An unreadable process is
  skipped: another uid's process cannot open a 0700 store unless it is root, which is outside the model, and I2
  covers this uid's. The scan is a snapshot: a process that opens a dead creator's store by path after the scan can
  lose it. Nothing does that (I1).
- **Pid reuse.** If an unrelated process now has the dead creator's pid, `kill` reports it alive and the store stays
  until that pid dies too. A creator that is dead stays dead, so a pid reused after the check changes nothing.
- **Secrets.** A dead mainnet deploy's store holds an operator account's keys. With no holder left, its tmpfs pages
  go at the next store creation, not at reboot.
- **Known limits** (the close-out files each as a closed `known-limit` issue):
  1. No reap without `/proc` (macOS), nor on a disk root another uid can write. Sandbox-only stores then leak on
     disk, about 18 MB per SIGKILL, and fill no memory. Reopen: a report of disk growth.
  2. Holders this `/proc` cannot see: a process in another pid namespace that shares one `/dev/shm` under the same
     uid, or a non-dumpable process that holds a store. A live store can then be deleted, and its run fails. It
     needs a container setup the repository does not use (Docker gives each container its own `/dev/shm`) or a
     holder no code makes (I2). Reopen: a run that shares `/dev/shm` across pid namespaces, or a lost live store.
- **Least privilege, cryptography, supply chain:** no new dependency, permission, network call or key. N/A.

## Phases (arc a1)

### Phase 1: pid-named stores and the reap

1. In `wallet-store.ts`, add the pid to the name in `freshDir`. Add `reapDeadStores` and its helpers, and call it in
   `ownedWalletStore` before `freshDir`. Update the module's doc comments.
2. In `wallet-store.test.ts`, change the first test's name regex to `unleashed[-/\\]\d+-test-`. Make `storeOf` reject
   when the child exits before it prints. Kill and await every child a test spawns in a `finally`.
3. Add test T1 (`ownedWalletStore`, only where `/proc/self/fd` exists). Child A takes a store and stays alive; the
   test sends it SIGKILL and awaits its exit. Assert that A's store name starts with `unleashed-<A's pid>-test-`.
   Child B takes a store and stays alive. Child C takes a store and exits 0. Assert that A's store is gone and B's
   store exists. Then send B SIGTERM and assert that its store is gone. Do not assert that A's store survives the
   SIGKILL: a run in another worktree can reap it first.
4. Add test T2 (`reapDeadStores` on a scratch root from `mkdtempSync(join(tmpdir(), "reap test-"))`, whose space
   exercises the `maps` parse; only where `/proc/self/fd` exists). Take a dead pid from a `bun -e ""` child after its
   exit. Make these entries:
   (a) `unleashed-<dead>-test-a`, a directory with a file and a symlink to an outside directory with a file;
   (b), (c), (d) `unleashed-<dead>-test-{b,c,d}`, directories with a non-empty file each, which one live `bun -e`
   holder child holds: (b) by `openSync`, (c) by `process.chdir`, (d) by `Bun.mmap` kept in a global; it prints
   `ready` only after all three, and the test's wait rejects if it exits first;
   (e) `unleashed-<dead>-test-e`, a symlink to an outside directory with a file;
   (f) `unleashed-<own pid>-test-f`, a directory; (g) `unleashed-test-g`, a directory with the old name.
   First set the scratch root to 0777 (not sticky), run the reap, and assert that (a) remains: the root guard. Set it
   back to 0700. Run the reap. Assert that (a) is gone and that the file behind its symlink remains. Assert that (b) to (g), and
   the file behind (e), remain. Kill the holder, run the reap again, and assert that (b), (c) and (d) are gone.
   The uid check has no test: an unprivileged test cannot make a directory another uid owns. The unreadable-process
   path runs wherever another uid's process is visible, as on this host.
5. Measure both tests' runtime and write it in `lessons/phase-1.md`.

- **Gate:** `bun run lint`; `bun run typecheck:all`; `cd packages/bridge-core && bun --bun vitest run scripts/wallet-store.test.ts`
  (all pass; then make `reapDeadStores` return at once, see T2 fail, and restore it; T1 is no mutation control,
  because another worktree's run can reap A); `bun run test:all`; `bun run audit:tools`.
  Pass: exit 0 for each, and `bun run lint` reports no complexity regression. Layers: lint, typecheck, unit,
  integration (child processes). No UI change and no workflow change, so neither `e2e:tools` nor `lint:actions` runs.
  This host's full `/dev/shm` can SIGBUS a file in another package: count that as the host, rerun that file alone,
  and record it in `lessons/phase-1.md`.

## Decision ledger

| # | Decision | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Name | `unleashed-<pid>-<label>-XXXXXX`; prefix parse | pid last: a label that ends in digits would parse wrong |
| D2 | Liveness | `kill(pid, 0)`; only ESRCH means dead | the start time from `/proc/<pid>/stat` against reuse: the brief accepts reuse as the safe side |
| D3 | Held open | fd, cwd and `maps` under `/proc`, read once, only when a dead candidate exists | fd only (`Bun.mmap` holds by mapping alone, fact 3); `lsof` on macOS (a process per call, for a disk leak that fills no memory); a lock each creator holds (Node and Bun have no `flock`; a protocol for what the pid covers) |
| D4 | Unreadable process | skipped (fact 4, I2) | keep all candidates: `sd-pam` lives all session, so no reap would run; a pid-namespace id in the name (known limit 2) |
| D5 | Root guard | real root owned by uid 0 or this uid and sticky, or this uid's and not group- or other-writable | trust the root (a writable root lets another uid swap entries); check every ancestor (store creation already trusts them) |
| D6 | When | every `ownedWalletStore` call, before `mkdtemp` | once per process: a flag to save one listing |
| D7 | Test seam | export `reapDeadStores(root)` | a root option on `ownedWalletStore`, public for tests only; mocking `node:fs` for the uid check |
| D8 | Old pid-less names | never reaped; the owner clears them once | reap when unheld: between `mkdtemp` and LMDB's open nothing holds a live store |

## Audit verdicts

**Codex round 1 (`gpt-6.1-sol`, high): reject.** Every claim checked against the host and the tree.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | High: fact 4 equated unreadable with another uid; `(sd-pam)` is this uid and unreadable (demonstrated) | adopted as a fact; rejected its fix (keep candidates while any unreadable process lives): `sd-pam` lives all session, so the reap would never run. D4, I2, known limit 2 |
| 2 | High: a scan is a snapshot; a process that opens the store after it loses it (plausible) | adopted as a narrowed claim (I1, Security); no lock protocol (Not taken e). Rejected: a pid reused after the check does not matter, a dead creator stays dead |
| 3 | Medium: a mapping outlives its fd, so I2 overreached (demonstrated; `Bun.mmap` probe) | adopted: `maps` joins the scan (D3) |
| 4 | Medium: `~/.cache/unleashed` is 0775, not 0700 (demonstrated) | adopted: fact 5, root guard (step 1, D5) |
| 5 | Medium: T1's survival assertion races other worktrees' reaps; `storeOf` can hang; children leak on failure (demonstrated by inspection) | adopted: assertion dropped, `storeOf` rejects on exit, `finally` kills. Rejected: retry or skip on a reused fixture pid (no retries; reuse within milliseconds needs 4 M allocations) |
| 6 | Medium: T2 misses nested symlinks, cwd and mapping holders, EACCES, foreign uid (demonstrated gaps) | adopted: nested link in (a), holders (b)–(d). EACCES runs on every Linux host (pid 1). Foreign uid: no unprivileged fixture, and a mock tests the mock |
| 7 | Low: state the severity of known limit 2; soften "keys leave RAM" and "no measurable time" | adopted |

**Codex round 2 (resumed): conditional approve.** Finding 1's rejected fix accepted on the `sd-pam` evidence; I2
with known limit 2 judged proportionate; D3, D4, the snapshot narrowing and T1 stand. Conditions applied.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Medium: a sticky root's owner may rename any entry, so an attacker-owned sticky root passes the guard (plausible; `rename(2)`) | adopted: step 1 requires owner uid 0 or this uid on a sticky root, on the real path. Rejected: an ancestor check (Security § Planted symlink) |
| 2 | Low: a whitespace split truncates a `maps` path that holds a space | adopted: step 4's parse; T2's root name holds a space |
| 3 | Low: T2's holder must keep the mapping and report ready only after all three holds | adopted: T2 (b)–(d) |
| 4 | Low: Summary and Excellent still said "never" for any holder; the pid 1 claim overreached | adopted: both qualified |

**Final fresh Codex pass (new session): conditional approve.** No settled disposition reopened; structure, tests
and limits judged proportionate. Conditions applied.

| # | Finding (label) | Disposition |
|---|---|---|
| 1 | Medium: the gate skipped `bun run audit:tools`, which AGENTS.md requires before a PR (demonstrated) | adopted: phase gate and Delivery |
| 2 | Medium: no test fails if the root guard regresses (demonstrated gap) | adopted: T2 first runs on a 0777 root and asserts (a) remains |
| 3 | Low: T1's mutation check can pass on a shared host, as another worktree can reap A (plausible) | adopted: the mutation check runs on T2 |
| 4 | Low: fact 2 said only the creator knows a store's name; `/dev/shm` lists it to every uid (demonstrated) | adopted: fact 2 restated; I1 rests on what code does |

**Final pass, resumed to verify the conditions: approve.** No regression found.

## Delivery

One arc, one PR against `main`: a1 = phase 1 plus the close-out commits, `Closes #52`, code review `off`. Branch
`worktree-wallet-store-1`; the plan commit is its first commit. Touch only bridge-core's script layer. Merge
`origin/main` before the last gate run. One phase, so nothing runs in parallel. Size: over the 150-line target by the
three audit tables and the verbatim review rules; nothing is restated.

## Post-implementation

1. **Codex fix loop** over the net diff from 2aaec3a: `~/.claude/skills/codex/scripts/run-codex.sh <prompt-file>
   <worktree> high read-only gpt-6.1-sol`, prompt in `implementations-plan/wallet-store-1/_codex-diff.md`. Send the
   diff, this plan, the ledger, the adversarial ask (planted names, symlinks, other uids, holders, pid reuse), the
   line "Never open, read, cat, list or search a local `.env` file or any `*.env` file (an `*.env.example` template is
   fine). Never open, list or search `~/.agents/orchy/`.", and verbatim: "Report bugs and small, targeted improvements
   only. Do not propose speculative abstractions, extra configuration surface, new layers, or rewrites — the
   smallest change that fixes each real problem. If code works and is clear, leave it alone." and "Audit the comments
   for value per character. Flag any comment that narrates what the code visibly does, restates its line, references
   implementation plans / phases / reviews, or spends a paragraph where a sentence works — and flag places where a
   non-obvious invariant or constraint deserves a comment it doesn't have." Verify each claim, fix, commit, log the
   round in `lessons/phase-1.md`, then `resume-codex.sh "" <followup> <codex-dir> high` until a round has no material
   finding. Stop after three rounds and surface. A fix that adds state, a lifecycle, a protocol, a recovery policy or
   a public contract stops for approval.
2. **Delivery.** `bun run test:all`, `bun run lint` and `bun run audit:tools` green after `git merge origin/main`; then `gh pr create`
   (title ≤ 93 characters, Conventional Commit; body: changes, validation with outcomes, test runtimes, `Closes #52`).
3. **Close-out**, as the PR's final commits, after a read of what `origin/main` changed in `index.md` and
   `lessons.md`: the `## Outcome` block after the front matter (status, shipped with the PR number,
   `Known limits:`, `Open items:`, seeds retired); promote generalizable lessons to `lessons.md` (dedupe, retire,
   under 8 KiB); file known limits 1 and 2 as closed `known-limit` issues (`gh issue list --state all --search
   "wallet store"` first); delete `STATUS.md`; then, in its own commit,
   `git mv implementations-plan/wallet-store-1 implementations-plan/archive/wallet-store-1` and add one line to
   `implementations-plan/archive/index.md`. No row in `index.md`. Then `gh pr checks --watch` and report.
4. **Teardown** after the orchestrator merges: `agent-worktree done wallet-store-1 --merged`; relay a refusal, never
   force.
5. **Owner's step** (not the lane's): remove the old pid-less `unleashed-*` stores on shared hosts once, by hand.

Where open work lives: a bug or gap → an issue with a `Record` link; a product call → `owner-decision`; a suspected
exploitable weakness → a private draft advisory; a finding needing unsupported conditions → a closed `known-limit`
issue; knowledge → `lessons.md`.

## Seeds (draft; run none)

```
/goal Phase 1 of implementations-plan/wallet-store-1/plan.md marked ✓ with its gate reported passing in the transcript; the Codex fix loop converged (a resumed pass quoted with no material finding); the PR exists with Closes #52 and carries the close-out archive commit; bun run test:all and bun run lint exit 0.
```

```
/loop 15m Drive implementations-plan/wallet-store-1/plan.md: read plan.md and lessons/, take the next unticked step, run its gate exactly, tick it; at the end run Post-implementation 1–3; never merge or open a .env file; stop after three failures on one step.
```
