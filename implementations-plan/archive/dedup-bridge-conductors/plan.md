## Outcome

Archived. Seeds retired.

# Plan — dedup-bridge-conductors (Arc 4 of the dedup audit)

**Tier**: `/blueprint light`
**Scope**: Q-02 (verified 10-file bootstrap set), Q-10 (private-FPC deploy twins)
**Approval**: standing authorization via the owner's `/goal`. ELI5 omitted (autonomous mode).

## Assumptions

**Facts (verified table re-checks; Q-10 from consolidated + fresh reads during implementation)**
1. Exactly 10 scripts carry the full L1+L2 bootstrap (verified table with per-file line refs); `deploy-sandbox.ts:148` is the sole `proverEnabled: false` and the sole file missing the `mins()` timer; 2 further L1-only scripts are OUT of scope (verified correction #1).
2. The bootstrap pieces are INTERLEAVED with per-script logic (e.g. `deposit-testnet.ts`: L1 clients at :86-87, EVM deploys, then L2 wallet at :104-105) — side-effect ordering differs per script.
3. `deploy-manifest.ts`/`deployer-keys.ts` are the precedent shared helpers and do NOT cover the bootstrap.
4. Config-arg loading diverges in the wild: `smoke-existing-testnet.ts` hard-requires `--config`; `fee-juice-canary-testnet.ts` silently falls back to the live manifest (verified: a footgun for a candidate-validating canary).
5. Q-10: `deploy-private-fpc-{mainnet,testnet}.ts` share timer/node+pin/idempotency-check/deploy+assert scaffolding (~92-line overlap); only fee/account setup genuinely differs.

**Inferences (audit: challenge)**
- I1 (deviation from verified's single-factory sketch; codex-sharpened): FOUR split factories — `createL1Clients`/`createL1PublicClient` + `createNode` + `createL2Wallet` — never a combined multi-client factory. Rationale: scripts interleave L1, node, and wallet creation with domain logic between (F2; deploy-bridge-mainnet and fpc-dust-canary create node and wallet on OPPOSITE sides of fund-moving logic); any combined factory would reorder network side effects. Each call site keeps its exact ordering.
- I2: `proverEnabled` REQUIRED (non-defaulted) on `createL2Wallet` — verified's concrete drift fix, kept.
- I3: chain constants become `sepoliaChain(rpcUrl)` / `mainnetChain(rpcUrl)` factories (the RPC URL is per-script env-derived, so constants can't be static objects).

## Architecture & Implementation

### Q-02 — `packages/bridge-core/scripts/script-bootstrap.ts` (Extract Function; AMENDED per codex reject)
```ts
export function sepoliaChain(rpcUrl: string): Chain      // uniform across all 6 sepolia blocks (codex-verified)
export function mainnetChain(rpcUrl: string): Chain      // uniform across all 3 mainnet blocks
export function createL1Clients(opts: { chain: Chain; rpcUrl: string; account: PrivateKeyAccount }): { wallet: WalletClient; pub: PublicClient }
export function createL1PublicClient(opts: { chain: Chain; rpcUrl: string }): PublicClient
	// wallet-BEFORE-public construction order preserved inside createL1Clients; the account-carrying
	// overload returns a NON-optional wallet (all 10 callers pass an account)
export function createNode(nodeUrl: string): AztecNode
export async function createL2Wallet(opts: { nodeUrl: string; proverEnabled: boolean }): Promise<EmbeddedWallet>
	// node and wallet are SEPARATE factories (codex blocking: deploy-bridge-mainnet creates wallet →
	// FJ deposit/possible early return → node at :337; fpc-dust-canary creates node → fee checks → wallet
	// at :99 — a combined factory would reorder network side effects). proverEnabled REQUIRED.
export function stopwatch(): () => string
export function loadManifestFromConfigArg<T>(argv: string[], opts: { mode: "required"; parse: (raw: unknown) => T } | { mode: "fallback"; fallbackPath: string; parse: (raw: unknown) => T }): T
	// discriminated mode + injected parser (canary keeps parseCandidateManifest, smokes keep plain
	// JSON.parse-shaped parsing). The canary KEEPS its live-manifest fallback — zero-change; the dedup
	// win is that the choice is now stated at the call site, not that the behavior changes.
```
Migration: all 10 scripts; `deploy-sandbox.ts` keeps `proverEnabled: false` (now visibly stated) AND its peculiar second public client (`chain: sandbox`, Sepolia transport, `:126`) stays outside the helper. Scripts keep their genuine deltas verbatim (verified keep-list). Timer extraction covers the 12 `mins()` files incl. the 3 outside the bootstrap set.
**Gate note (codex)**: `deploy-sandbox.ts` is excluded by `tsconfig.scripts.json` — investigate the exclusion during implementation; if trivially includable, include it (gate improvement), else hand-review + biome as its gate and record why.

### Q-10 — `deployCanonicalPrivateFpc` (AMENDED shape per codex)
The helper performs the EXISTENCE CHECK FIRST and early-returns before any wallet creation (both twins do exactly this today — a `{node, ewallet}`-taking surface would reorder it). Shape: `deployCanonicalPrivateFpc({ nodeUrl, prepare })` — owns stopwatch + node client + canonical-pin read + exists-early-return, THEN creates the EmbeddedWallet and calls `prepare({ ewallet, node, mins })` returning `{ from, fee }`, then deploys `PrivateFPCContract` (`PRIVATE_FPC_SALT`, `universalDeploy: true`), asserts address === pin, logs. Unit tests (bb-free, fakes at the node/wallet seam): early-return-before-wallet-creation, exact salt/options passed, pin-mismatch rejection, callback sequencing.

## Phases & validation gates
1. `script-bootstrap.ts` + unit tests where bb-free (chain factories, stopwatch, loadManifestFromConfigArg with temp files; client factories are thin viem/aztec wrappers — typecheck + the scripts' own usage cover them, no mock-heavy tests). Gate: `bun run --cwd packages/bridge-core test` + typecheck.
2. Migrate the 10 scripts + 3 extra timer files (subagent-assisted, explicit-path staging, hand-reviewed diffs). Gate: bridge-core tests + `bun run typecheck:all` — with the documented EXCEPTION that `deploy-sandbox.ts` sits outside `tsconfig.scripts.json` (investigate inclusion; else its gate is hand-review + biome, recorded in lessons).
3. Q-10 twins. Gate: bridge-core suites.
4. Whole-arc: `bun run audit:vue`.
5. Post-impl: ONE codex xhigh diff pass → converged → PR → babysit → squash-merge.

## Security & Adversarial Considerations
- These scripts move real funds on mainnet/testnet. The extraction deliberately does NOT touch deploy/claim/journal logic (keep-list); only client construction, timer, and config-arg loading move. `proverEnabled` required-param is a hardening (no silent WASM/prover drift).
- `loadManifestFromConfigArg`'s discriminated mode makes the canary's live-manifest fallback EXPLICIT at its call site — the behavior is deliberately retained (zero-change); whether to remove the fallback is an owner follow-up, not this arc's call.

## Trade-offs / alternatives rejected
Single all-four factory (I1 — reorders side effects); folding the 2 L1-only scripts in (out of verified scope); touching mainnet conductors' staged-broadcast/journal logic (keep-list).
