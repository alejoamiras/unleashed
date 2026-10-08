# Security

## Reporting a vulnerability

Please open a private security advisory against the repository on GitHub.
Do not file public issues for security bugs.

## Dependency policy

- **Minimum release age: 7 days** (`bunfig.toml` `minimumReleaseAge = 604800`). A freshly published
  version cannot install until it is a week old, which is the window in which compromised publishes
  are usually caught and pulled.
- **CVE bypass.** When a fix is younger than the gate, add its name to `minimumReleaseAgeExcludes`,
  install, and delete the entry again in the same PR once `bun.lock` holds the version. A frozen
  install never re-gates; prove it with `bun install --frozen-lockfile --force`. Until the version is
  7 days old, a `package.json` edit in a workspace that reaches it re-gates it and fails the install:
  wait, or add the exclude locally and do not commit it. A permanent exclude would switch the gate
  off for exactly the names where a publisher takeover matters.
- **Standing exemption: the Nulo wallet's packages** (`@nulo-sh/resolve-asset`, `-wallet-crypto`,
  `-wallet-sdk-schema-patch`), the owner's decision. They publish only from `nulo-sh/nulo`'s
  workflow through npm trusted publishing with provenance, and the exact pins mean a new version
  arrives only through a reviewed bump. Add no other name this way.
- **First-party packages** (`@alejoamiras/*`) go through the same gate. Before a temporary exclude
  for one, verify its provenance: install the exact versions into a scratch npm project with
  `npm install --ignore-scripts`, then run `npm audit signatures --include-attestations` there and
  check the attestations bind each tarball to its repository and commit. Run bare in this Bun tree,
  the command has no npm lockfile to audit and passes vacuously.
- **The Aztec line** (`@aztec-labs/*`, `@aztec-foundation/*`) is exact-pinned and bumped by hand; see [`UPDATE.md`](UPDATE.md).
- **`bun.lock` is committed** and CI installs with `--frozen-lockfile`. Review every bump with
  `bun pm diff`.
- **`bun audit`** runs in CI as an advisory step; its findings land in the job summary.
- No Renovate: dependency bumps are manual pull requests.
