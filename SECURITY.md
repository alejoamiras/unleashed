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
- **Standing exemptions: the Nulo wallet's packages and the PrivateFPC artifact**, each the owner's
  decision. The Nulo wallet's packages (`@nulo-sh/resolve-asset`, `-wallet-crypto`,
  `-wallet-sdk-schema-patch`) publish only from `nulo-sh/nulo`, and `@alejoamiras/private-fee-juice`
  publishes only from `alejoamiras/ecosystem-tooling`. Each publishes through npm trusted publishing
  with SLSA provenance from that one repository, and each is exact-pinned, so a new version arrives
  only through a reviewed bump. No other name is added this way without the owner's decision.
- **First-party packages** (`@alejoamiras/*`) other than `private-fee-juice` go through the same
  gate. Before a temporary exclude for one, verify its provenance: install the exact versions into a scratch npm project with
  `npm install --ignore-scripts`, then run `npm audit signatures --include-attestations` there and
  check the attestations bind each tarball to its repository and commit. Run bare in this Bun tree,
  the command has no npm lockfile to audit and passes vacuously.
- **The Aztec line** (`@aztec-labs/*`, `@aztec-foundation/*`) is exact-pinned and bumped by hand; see [`UPDATE.md`](UPDATE.md).
- **`bun.lock` is committed** and CI installs with `--frozen-lockfile`. Review every bump with
  `bun pm diff`.
- **`bun audit`** runs in CI as an advisory step; its findings land in the job summary.
- No Renovate: dependency bumps are manual pull requests.

## The dRPC key

- **The browser holds no key.** The testnet bundle calls dRPC's keyless public endpoint,
  `https://aztec-testnet.drpc.org`, and the mainnet placeholder calls no node.
- **Scripts use one key**, `DRPC_API_KEY`: the owner's shared dRPC CLI key, restricted to the
  operator host's IP. It exists only in 1Password (`Keyed-Runs/dRPC-CLI`) and reaches a run only as an
  owner-approved keyed run from the `*.env.example` templates. `requireDrpcNodeUrl`
  (`packages/bridge-core/src/drpc-node.ts`) composes the node URL from it and has no default. No
  script prints that URL, records it in a deploy intent or puts it in an error. The Aztec node client
  prints its URL on a failed call, so a script takes the URL only from `keyedNodeUrl`
  (`packages/bridge-core/scripts/keyed-run.ts`), which refuses until `runKeyed` routes the SDK's logs
  and the run's failure through redaction of every keyed value (`scripts/ci-cd/keyed-runs.test.ts`).
  env-exec's masking is the second layer, so a failing keyed command is still never re-run outside
  env-exec.
- **No key is ever committed.** `scripts/ci-cd/node-keys.test.ts` fails on a keyed `lb.drpc.live` URL
  anywhere in the tree, archived records included. Keys committed before the split stay in git
  history; only disabling them in dRPC retires them.
- **On a leak**, disable the key in dRPC, mint a new one, and replace the `DRPC_API_KEY` field of
  `Keyed-Runs/dRPC-CLI`. All the owner's projects share the key, so one rotation covers them all.
