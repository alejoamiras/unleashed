# AGENTS.md

Operating rules for anyone working in this repository, human or agent. [`README.md`](README.md) is
the map; this file is the ruleset. `CLAUDE.md` imports it.

## Read before you start

- The README of the package you touch: [`apps/tools`](apps/tools/README.md),
  [`packages/bridge-core`](packages/bridge-core/README.md), [`packages/design`](packages/design/README.md),
  [`contracts/bridge/evm`](contracts/bridge/evm/README.md), [`contracts/bridge/aztec`](contracts/bridge/aztec/README.md).
- [`apps/tools/tests/browser/README.md`](apps/tools/tests/browser/README.md) before touching the
  browser suite: the parallel-safe runner, the fixtures, the egress rule.
- [`implementations-plan/lessons.md`](implementations-plan/lessons.md): what already bit this
  repository.

## The app is a dApp

`apps/tools` must work with **every wallet that speaks `@aztec-labs/wallet-sdk`**. Send, Exit and Drip use
only the standard surface (`requestCapabilities`, `registerContract`, `executeUtility`,
`simulateTx`, `sendTx`, `createAuthWit`). The wallet-specific RPCs that
`@nulo-sh/wallet-sdk-schema-patch` adds (`registerToken`, `isTokenRegistered`,
`grantPublicAuthwit`) are optional conveniences and must **fail open** on a wallet without them;
nothing on the bridge's critical path depends on them. The browser suite drives the real UI
against an embedded wallet-sdk test wallet and an injected EIP-1193 wallet, never against a
product wallet, so a green run proves the app and not a pairing.

## The Nulo wallet is a separate product

The Nulo wallet is developed in its own repository, `nulo-sh/nulo`. No test here reads, builds
or boots it, and nothing here imports from it except its three published npm packages. The two
repositories share exactly four facts, each with one owner:

| Fact | Owner | Mirror | How it moves |
|---|---|---|---|
| Bridged-token L2 addresses | here: `apps/tools/public/*-bridge.json`, `tokens[].l2Token` | the wallet's default tokens and price map | The wallet mirrors a promoted generation by hand, as its own UI decision. It mirrors nothing today. |
| PrivateFPC salt and canonical address | here: [`packages/bridge-core/src/private-fpc-canonical.json`](packages/bridge-core/src/private-fpc-canonical.json) | the wallet's `protocol-fpcs.ts`, pinned by its own test | A re-pin here is announced to the wallet's repository; on a reset network the wallet's private fee path waits for this repository's FPC deploy. |
| The Aztec line (`@aztec-labs/*`, `@aztec-foundation/*`) | the wallet's repository, which publishes the shared packages | the exact pins here | The wallet publishes new versions of the three packages on the new line first; [`scripts/ci-cd/published-packages.test.ts`](scripts/ci-cd/published-packages.test.ts) holds every peer to this repository's pin, so a bump here cannot land before they exist. |
| Chain identity (chainId, rollup version) | each repository, independently | none | [`apps/tools/src/lib/chain-constants.ts`](apps/tools/src/lib/chain-constants.ts) here; the wallet keeps its own copy. |

Driving the app with the Nulo wallet is a manual pre-release check, never a CI gate. The
three published packages are `@nulo-sh/wallet-crypto` (`EncryptionKey`, which seals the
bridge-record backups), `@nulo-sh/resolve-asset` and
`@nulo-sh/wallet-sdk-schema-patch`; they are exact-pinned dependencies like any other.

## Skills and runbooks own their domains

| Learned something about… | Write it into |
|---|---|
| Deploying a bridge generation, pre-creating tokens, calibration, promotion, the live canaries | [`bridge-generation`](.claude/skills/bridge-generation/SKILL.md) |
| What an Aztec-line bump touches | [`UPDATE.md`](UPDATE.md) |
| The browser suite | [`apps/tools/tests/browser/README.md`](apps/tools/tests/browser/README.md) |
| A plan-specific debugging log | `implementations-plan/<plan>/lessons/` |

A rule or policy goes here. Keep each lesson in one place.

## Working in this repo

- **Bun** is the package manager and the test runtime, pinned to `1.4.2` in
  `package.json#packageManager` and the `setup-bun` action. `bun.lock` is lockfile version 2, which
  Bun 1.3 cannot read: every host that installs runs 1.4 or newer, including Workers Builds
  (`BUN_VERSION` build variable).
- **The linker is `isolated`** (`bunfig.toml`). A workspace resolves only what its `package.json`
  declares; an undeclared import can still resolve locally through the store's hoist fallback and
  then fail on CI's fresh runner. Declare every package a workspace imports, type-only imports
  included. Never walk `node_modules` by hand: `@nulo-sh/resolve-asset` resolves from the
  caller. [`packages/bridge-core/scripts/layout-identity.test.ts`](packages/bridge-core/scripts/layout-identity.test.ts)
  is the executable guarantee.
- **Unit tests run on Bun** (`bun --bun vitest run`). Every unit vitest config spreads `sharedTest`
  from [`vitest.base.ts`](vitest.base.ts); its `deps.interopDefault: false` is a stopgap for vitest 4
  mistaking Bun's ES-module namespaces for CommonJS, removable once the installed vitest carries
  vitest-dev/vitest#10363.
- **Biome** lints and formats. `noExplicitAny` is an error: use `unknown` and narrow. The tools app
  may take chain identity only from `@/lib/network`, never `viem/chains` (a Biome import rule).
- **Commits** are Conventional Commits with a lower-case subject, checked by the commit-msg hook and
  in CI. The pre-commit hook runs Biome on staged files, the absolute-path guard and the complexity
  baseline; `bun install` installs the hooks.
- **Complexity budgets** are Biome errors: cognitive complexity ≤ 15 everywhere, ≤ 80 non-blank lines
  per production function. [`scripts/complexity-baseline/manifest.json`](scripts/complexity-baseline/manifest.json)
  holds three accepted exceptions, each justified at its line; the list only shrinks, and only
  `bun run baseline:complexity` writes it.

## UI changes need the owner's sign-off

A change to what a user sees (layout, copy, which rows a screen shows, how a value is formatted) is
the owner's decision. A plan lists every visible surface it touches; the owner approves it in
writing, quoted in the plan or the PR; the PR attaches screenshots. A passing test or a reviewer's
approval is not a sign-off.

## Branching and merging

- `main` is the only long-lived branch. Work happens on short-lived branches and lands through
  squash-merged pull requests; the PR title becomes the commit subject, so write it as a
  Conventional Commit of at most 93 characters (GitHub appends ` (#NN)`, and commitlint caps the
  subject at 100).
- Required on `main`: `quality-status`, `tools-e2e-status`, `bridge-contracts-status`, all produced
  by exact-state aggregators, plus signed commits. Merging never uses `--admin`.
- Renaming an aggregator blocks every merge until the protection follows it. Ship the rename with
  the runbook: record the old → new pair in `RENAMES` (`scripts/ci-cd/required-checks.ts`), run
  `scripts/ci-cd/required-checks.sh print --branch main --json > <file>` and review it, then
  `scripts/ci-cd/required-checks.sh --apply --branch main --expect <file>` right before the merge.
  `scripts/ci-cd/behavior-gating.test.ts` pins each workflow's aggregator name.
- A red check is a flake to re-run or a break to fix. It is never made advisory, skipped, or
  removed from the required set to get a merge through.

## Dependency policy

- **7-day minimum release age** (`bunfig.toml`). A CVE fix newer than the gate goes in through a
  temporary `minimumReleaseAgeExcludes` entry that leaves in the same PR; prove it with
  `bun install --frozen-lockfile --force`. Until the version is 7 days old, a `package.json` edit in
  a workspace that reaches it re-gates it and fails the install: wait, or add the exclude locally and
  do not commit it. Details: [`SECURITY.md`](SECURITY.md).
- **The Aztec line (`@aztec-labs/*`, `@aztec-foundation/*`) is exact-pinned and bumped by hand**, after the wallet's repository has published the
  shared packages on the new line. [`UPDATE.md`](UPDATE.md) lists what a bump touches; a bump that
  resets the network is a new bridge generation ([`bridge-generation`](.claude/skills/bridge-generation/SKILL.md)).
- `bun audit` runs in CI as an advisory step. No Renovate: dependency bumps are manual PRs.

## Hosting

The app is two assets-only Cloudflare Workers (`wrangler.testnet.jsonc`, `wrangler.mainnet.jsonc`)
built and deployed by Workers Builds with the repository connected in the Cloudflare dashboard.
GitHub Actions holds no Cloudflare credential and never deploys. The build target is picked by the
command, never by a dashboard variable; previews exist on testnet only, and a testnet build runs at
any preview host of its Worker while a mainnet build runs at its two production hosts only. The
custom domains (`app.unleashed.systems`,
`testnet.app.unleashed.systems`) are attached in the dashboard, not in the wrangler configs.
[`apps/tools/README.md`](apps/tools/README.md) § Production build +
hosting has the commands and the host model.

## Security

Treat every change as attack surface. The bridge moves real funds on mainnet: a derivation, a
salt, a manifest field or an authwit scope is protocol, and a change to one is reviewed as such.
Live deploys follow the runbook's authorization gates and never sign without them. Keys live in
1Password and reach a run only as an owner-approved keyed run (`env-exec`, from the `*.env.example`
templates), or in local `.env` files that git ignores; an agent never creates one, and none reaches
CI. Security
reports go through GitHub's private advisories ([`SECURITY.md`](SECURITY.md)).

## Code comments

Say what the code cannot: invariants, constraints, non-obvious reasons, external quirks. Never
narrate what a line does, and never cite a plan, phase, PR or review; git history carries
provenance. Public APIs get a TSDoc contract (parameters, invariants, failure modes) without filler.

## Plans

Non-trivial work gets a plan under `implementations-plan/<plan>/` (`plan.md`, `lessons/phase-N.md`).
[`implementations-plan/index.md`](implementations-plan/index.md) lists active plans only; a closed
plan gains an `## Outcome` block and moves to `archive/`, where it is history, never a task list.
Audit transcripts, drafts and ELI5 pages are gitignored. Generalizable gotchas are promoted into
`lessons.md` (kept under ~8 KiB), open work into `follow-ups.md`. No absolute local paths in any
committed file.

- **Plans carry no calendar dates.** A plan, a lesson or an audit states a tool version, a network
  identity or a block number where it needs provenance; when something happened is git's to record.
- **An archived deployment record keeps what is checkable and drops what is not.** When a plan
  closes, its intent and promotion receipt keep their addresses, digests and caps, and lose their
  timestamps and commit ids: a branch commit does not survive the squash merge, so the id would
  name nothing. A record without its build commit can never authorise a run (`live-intent.ts`
  refuses it).

## Quality gates

| When | Command |
|---|---|
| After any change | `bun run lint` and `bun run typecheck:all` |
| Before a PR | `bun run audit:tools` (typecheck, unit tests, lint, deployment check, build) and `bun run test:all` |
| Workflow or CI script changes | `bun run lint:actions` and `bun run test:ci-gating` |
| The app's UI or its bridge flows | `bun run e2e:tools` (boots and reaps its own sandbox; parallel-safe) |
| Contracts | the contract READMEs' build and test commands; CI runs them in `bridge-contracts.yml` |

CI: `pr-quick.yml` (`quality-status`: commitlint, lint and typecheck, unit tests, both builds with
`verify:build-target`), `pr-tools-e2e.yml` (`tools-e2e-status`, six sandbox shards, on the tools
graph or the `e2e:tools` label), `bridge-contracts.yml` (`bridge-contracts-status`: Foundry, halmos,
Noir, TXE, the sandbox integration suite), `actionlint.yml`. Every PR workflow opens with a
`changes` paths-filter job; `workflow_dispatch` bypasses it.
