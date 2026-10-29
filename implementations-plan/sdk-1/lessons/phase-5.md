# Phase 5 lessons

## 5.1 README, examples, publish workflow

- **npm reads Bun's tarball.** `npm publish <tgz> --dry-run --ignore-scripts` (an empty `HOME`, no upload) on the
  tarball `pack:check --out` wrote reported `+ @unleashed/sdk@0.1.0`, so the publish job needs no npm repack.
- **Trusted publishing needs npm 11.5.1+.** Node 24.5.0 was the first 24.x to bundle it (nodejs.org's release index);
  `setup-node` with `node-version: 24` resolves the latest 24.x (npm 11.19 today). `setup-node` v5+ restores a
  package-manager cache by default, so the token-holding job turns it off.
- **`download-artifact` v8 fails on a hash mismatch by default**, but against the digest the artifact service stored;
  the pack job's own digest, passed as a job output, is what binds the upload to the tested bytes.
- **A referenced environment that does not exist is created unprotected on first use.** Until the owner creates
  `npm-publish` limited to `main`, the job-level `if: github.ref == 'refs/heads/main'` is the only branch guard.
- **`pack:check` takes about 26 s locally**, cheap enough for every SDK-touching PR.
- **The examples resolve `@unleashed/sdk` by self-reference** (the workspace manifest's `exports`), so they import
  the package as an integrator does and typecheck in `typecheck:all`; a wrong `privacy` literal fails it.
- **Mutation-checked gating tests.** Dropping `LICENSE` from the `sdk-pack` filter, adding `contents: read` to the
  publish job, or prefixing the publish with `npm ci` each fails its test.
- **Review round 1 found no pipeline defect and ten documentation ones.** Each README sentence was checked against
  the source by both reviewers. The costly misses were contracts read off a type rather than its throw sites:
  `submission` describes the failing call, not the transfer (a claim's refusal says `none` on a sent deposit), and
  `deposit-reverted` means three things (simulated: `none`; send failed: `unknown`; mined: `submitted`). Docs that
  tell an integrator when to drop a record must key on both `code` and `submission`.
- **npm's trusted-publisher entries changed under us.** Since Sep 2026 a new entry allows only `npm stage publish`
  unless direct `npm publish` is enabled, and an entry unused for two days expires (npm docs, trusted publishers).
- **Round 2: a fix to a contract sentence needs the same throw-site sweep as the original.** Rewording `submission`
  as "the failing call" fixed the preflight `none` and broke every later claim error, which says `submitted` for the
  deposit with no claim sent. And "reverted on chain" is not "nothing moved" until the block is final.
