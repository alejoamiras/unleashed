# wallet-store-1: phase 0 (planning)

Consults, in order. Codex runs `gpt-6.1-sol` at `high`, read-only.

## Round 1: plan audit (new session) — reject

Seven findings, all checked on the host: `(sd-pam)` and a zombie `bb` of this uid have unreadable `/proc` files;
`~/.cache/unleashed` is 0775; `Bun.mmap` holds a file by mapping alone. Adopted: the unreadable-process fact, `maps`
in the scan, the root guard, the narrowed snapshot claim, the test hardening, the wording. Rejected: keeping every
candidate while an unreadable process lives (`sd-pam` would stop every reap), a lock protocol, retries on a reused
fixture pid, a mocked foreign-uid test. Dispositions in `plan.md` § Audit verdicts.

## Round 2: plan audit (resumed) — conditional approve

Finding 1's rejected fix accepted on the `sd-pam` evidence. Conditions adopted: the sticky root must be owned by uid 0
or this uid (a sticky directory's owner may rename any entry); `maps` paths keep spaces; T2's holder keeps its
mapping and reports ready after all three holds; "never" qualified. Rejected: an ancestor check (store creation
already trusts the root's path).

## Final pass (new session) — conditional approve, then approve on resume

Conditions adopted: `bun run audit:tools` in the gate and Delivery; T2 asserts the root guard on a 0777 root; the
mutation check moves to T2 (another worktree's run can reap T1's child A); fact 2 no longer claims a secret name.
The resumed pass verified all four: approve.
