# unleashed

An any-ERC-20 bridge between Ethereum and Aztec, and the tools app that drives it. The app is a
standard Aztec dApp: it reaches a wallet only through `@aztec-labs/wallet-sdk`, so any wallet that speaks
it can connect.

| Path | What it is |
|---|---|
| [`apps/tools`](apps/tools/README.md) | The tools app: Bridge (send and exit any ERC-20), Faucet (testnet tokens), Activity. |
| [`packages/bridge-core`](packages/bridge-core/README.md) | The bridge logic over `viem` and `aztec.js`, plus the conductor, verifier and canary scripts that deploy and check a generation. |
| [`packages/design`](packages/design/README.md) | The app's design system: tokens, fonts, primitives. |
| [`contracts/bridge/evm`](contracts/bridge/evm/README.md) | L1 contracts (Foundry): `PortalFactory`, the portal clones, `SwapBridgeRouter`. |
| [`contracts/bridge/aztec`](contracts/bridge/aztec/README.md) | L2 contracts (Noir): `TokenBridgeHub` and its derivation libraries. |
| [`implementations-plan`](implementations-plan/index.md) | Plans, their lessons, and the closed plans under `archive/`. |
| [`audit`](audit/security) | Security review reports. |

## Quick start

```bash
bun install                 # Bun 1.4 or newer
bun run dev:tools           # the testnet target on a local dev server
bun run audit:tools         # typecheck, unit tests, lint, deployment check, build
```

The browser suite and the contract suites need the Aztec toolchain and Foundry; see
[`apps/tools/tests/browser/README.md`](apps/tools/tests/browser/README.md) and the two contract
READMEs.

## Hosting

Two Cloudflare Workers serve the built app as static assets, one per network:
`testnet.app.unleashed.systems` and `app.unleashed.systems` (mainnet). Each Worker also answers at
its own host, `unleashed-testnet.alejo-amiras.workers.dev` and
`unleashed-mainnet.alejo-amiras.workers.dev`. The
target is chosen at build time, never at runtime. Workers Builds deploys `main` to production; the
testnet Worker also uploads a preview for each other branch its dashboard settings let it build,
and the mainnet Worker has no previews. Both mainnet hosts sit behind Cloudflare Access (application
`unleashed-mainnet`, policy "Only Foundation & Labs": `@aztec.foundation` and `@aztec-labs.com`
identities), so neither the public nor automation reaches them. Until a landing page exists,
`unleashed.systems` and `www.unleashed.systems` redirect (302) to the testnet app: a dashboard
redirect rule, to retarget when mainnet opens. No Cloudflare credential exists in
GitHub Actions. Details:
[`apps/tools/README.md`](apps/tools/README.md) § Production build + hosting.

## Where the rules live

- [`AGENTS.md`](AGENTS.md): how to work here, for people and agents.
- [`UPDATE.md`](UPDATE.md): what a bump of the Aztec line touches.
- [`.claude/skills/bridge-generation`](.claude/skills/bridge-generation/SKILL.md): deploying a new
  bridge generation, the runbook a network reset runs in full.
- [`SECURITY.md`](SECURITY.md): reporting a vulnerability, and the dependency policy.

Apache-2.0, see [`LICENSE`](LICENSE).
