# Aztec Faucet — Plan Brief

This brief is the shared context for three parallel planners (the
orchestrator, an Opus 4.7 agent, and Codex). All three produce an
independent plan; the orchestrator consolidates.

---

## Goal

Build a faucet web app for the Aztec Network — a new `packages/faucet/`
in this monorepo — that lets visitors connect any Aztec wallet (the Nulo wallet
first, but wallet-agnostic via `@aztec/wallet-sdk`) and drip themselves
test tokens (USDC, ETH) into either their **public** or **private**
balance.

The audience is the **Aztec Foundation team** (internal, trusted). The
faucet exists so they have something concrete to interact with while
trying the Nulo wallet + the Wonderland AMM/swap.

Success: the user can land on the page, connect the Nulo wallet, click "Drip 1000
USDC to Public", and see the tx confirm on alpha-testnet. Same for
private balance. Same for ETH. No backend. No rate limit. No
custodial wallet.

---

## Settled decisions (do NOT re-debate)

1. **Location**: NEW `packages/faucet/` in this monorepo. Vue 3 + Vite
   (matches the wallet's stack — easiest reuse of patterns).
2. **Network**: alpha-testnet ONLY. No sandbox switcher.
3. **Contracts**: deploy fresh Dripper + Token contracts as part of this
   PR. Commit resulting addresses into
   `packages/faucet/src/contracts/deployments.json`.
4. **Brand**: vendor design tokens (CSS vars taken from the Nulo wallet)
   into the faucet, build faucet components FRESH. Do NOT
   extract a shared UI package now.
5. **Wallet support**: any wallet via `@aztec/wallet-sdk` discovery (NOT
   gated to the Nulo wallet). It will be the first/only wallet in practice, but the
   connect flow is wallet-agnostic by design.
6. **Rate limit**: none. Trust the audience. Drip on every click.
7. **Drip amount**: FIXED per token. One canonical amount each.
   - USDC (decimals=6): **1000 USDC** per drip → on-chain `amount = 1_000_000_000` (u64)
   - ETH  (decimals=18): **1 ETH** per drip → on-chain `amount = 1_000_000_000_000_000_000` (u64)
   Note: Dripper takes `u64`, so any amount under 2^64 ≈ 1.8e19 is fine for
   our two tokens.
8. **Token labels**: name them "USDC" and "ETH"; show a visible "Test
   token · no real value" tag in the UI.

---

## Key technical facts (verified in the codebase)

### Contracts (Wonderland aztec-standards)

- `@defi-wonderland/aztec-standards@4.2.0-aztecnr-rc.2` ships a
  **permissionless** `Dripper` contract:
  ```rust
  #[external("public")]
  fn drip_to_public(token_address: AztecAddress, amount: u64)
  #[external("private")]
  fn drip_to_private(token_address: AztecAddress, amount: u64)
  ```
  No auth guards. Anyone can call.
- `Token` has `constructor_with_minter(name: str<31>, symbol: str<31>, decimals: u8, minter: AztecAddress)`.
  Deploy each token with the **Dripper's address as `minter`**, then
  `Dripper.drip_*` works because the dripper invokes
  `Token::at(addr).mint_to_{public,private}(msg_sender, amount)` and
  the Token's mint functions are `only` callable by the configured minter.
- The aztec-standards repo already ships
  a full `scripts/deploy.ts`:
    - `--network {devnet|testnet|local-network}`, `--output <path>`,
      `--dry-run`, `--deployer-secret <secret>` (or `DEPLOYER_SECRET` env)
    - Uses sponsored FPC for deploy fees
    - Creates a Schnorr deployer account derived from the secret
    - Computes deterministic addresses from salt (default `1337`)
    - Writes `deployments.json` in the exact shape the faucet should
      consume
  Recommend: REUSE this script directly
  rather than rewriting. Document the command in the faucet README.
  - The Wonderland TOKENS dict defines `weth`, `dai`, `usdc` by default
    (`scripts/deploy-config.ts`). For our faucet we want `usdc` + an
    `eth` entry (decimals=18). Decide: PR a config addition in
    aztec-standards, OR write a thin wrapper script in this repo that
    invokes deployment with our own token list + the SAME contract
    artifacts. (The wrapper is the lower-coupling path.)
- The Nulo wallet depends on `@defi-wonderland/aztec-standards@4.2.0-aztecnr-rc.2`
  and `@aztec/wallet-sdk@4.2.0`. The faucet should do the same. Note the
  version offset is intentional. The faucet can import the
  generated TypeScript artifacts from the npm package directly:
  `@defi-wonderland/aztec-standards/artifacts/Dripper.js` and
  `…/Token.js`.

### Wallet-SDK reference

The code below is the canonical reference for
the connect flow. Adapt this code; restyle it; don't reinvent it.

```ts
const manager = WalletManager.configure({ extensions: { enabled: true } })
const discovery = manager.getAvailableWallets({ chainInfo, appId: APP_ID, timeout: 60_000 })
for await (const p of discovery.wallets) { firstProvider = p; break }
const pending = await firstProvider.establishSecureChannel(APP_ID)
// → show emoji grid via hashToEmoji(pending.verificationHash)
const wallet = await pending.confirm()
const result = await wallet.requestCapabilities(manifest)
// → granted.accounts is the source of truth for connected accounts
```

`chainInfo: { chainId: Fr.ZERO, version: Fr.ZERO }` matches any wallet;
on alpha-testnet you might want to override via env. The reference
exposes a `?chainId=X&version=Y` query-param override — copy that
pattern so test drivers can pin.

### Brand source

- CSS variables, taken from the Nulo wallet:
  - `--app-bg: #0a0908`, the earlier `surface` token `#141312`, the earlier `accent` token `#f8f1e7`,
    the earlier `outline` token `#4a463f`, `--txt-primary: #f5f0e6`
  - Fonts: `--font-headline: "Space Grotesk"`, `--font-body: "InterVariable"`,
    `--font-mono: "JetBrains Mono"`
  - Theme system: `[theme="light"]` / `[theme="dark"]` selectors
- Typed reflection of the same tokens, also taken from the wallet
- Vendor BOTH (or their relevant subset) into
  `packages/faucet/src/design/`.

### Repo conventions (CLAUDE.md)

- **Bun** package manager (`1.3.13`); no npm/yarn/pnpm.
- **Biome** lint + format; `noExplicitAny` enforced as error; layer
  rules per-package via `noRestrictedImports`.
- **Conventional Commits**; subject lower-case; commitlint enforced.
- **No emojis** in code or UI unless explicitly requested.
- **No WHAT-comments**; explain WHY/INVARIANT only.
- **No milestone/phase/PR tags** in code comments.
- **Vue SFC ordering**: route → script → template → style; inside
  `<script setup>`: imports → macros → stores → composables → router →
  reactive state → service clients → handlers → watchers → lifecycle.
- **Tests colocated** as `<Name>.test.ts` next to `<Name>.vue`. Mount
  via `@vue/test-utils`. Coverage minimums: L1/L2 ≥5 cases, L3 ≥10,
  composables ≥10.
- **E2E selectors strict**: only `data-testid`. Never text/aria/role/class.
  Add testid to every new interactive element BEFORE writing the test.
- **Pre-commit hook** runs `biome check --staged` and a no-absolute-
  path guard. **Commit-msg hook** validates message.
- **`bun run audit:vue`** is the pre-PR gate (typecheck → test → lint →
  build). Faucet should slot into this.
- **Branching**: squash-merge feature branches into the base branch.

---

## What to produce

A markdown plan. The orchestrator will consolidate it with
the other two plans. **Aim for ~2500-3500 words** — depth matters more
than breadth. Use the following structure:

```
## 1. Summary
## 2. Architecture
## 3. File-by-file layout
## 4. Phase plan
## 5. Wallet-SDK integration details
## 6. UX & copy
## 7. Tests
## 8. Deploy story
## 9. Build & hosting
## 10. CI gates
## 11. Risks & open questions
## 12. Non-goals
## 13. One question I'd ask the user if I could
```

### Section requirements

**§2 Architecture** — one short diagram or numbered list. Where state
lives (composables vs Vue refs vs none). Contract layout.

**§3 File-by-file** — full tree of `packages/faucet/`. Each file: one-line
purpose. Be exhaustive.

**§4 Phase plan** — ordered phases. For each: what lands, files touched
(repo-relative), validation (`bun run …` command), risk + mitigation.

**§5 Wallet-SDK** — discovery, emoji verify modal, capability manifest
(actual manifest contents), contract registration order, fee payment
(sponsored FPC on alpha-testnet — the deployer script already shows how),
disconnect/reconnect.

**§6 UX & copy** — concrete copy, no placeholders. Tone: brutalist,
confident, no marketing fluff. Match the Nulo wallet's register. Cover:
- Hero headline + sub
- Empty "no wallet detected" + "install Nulo" CTA
- Connect button states (idle / discovering / verifying / connected / error)
- TokenCard idle / dripping / success / error states
- Drip success toast copy
- Common error toast copy (no wallet, user rejected, network down,
  tx reverted, no fee asset, account uninitialized)
- Footer microcopy

**§7 Tests** — be honest about ROI. CLAUDE.md says "succinctness, not
over-verbosity. Enough tests to prove what we wanted to implement works,
and that failures are caught. We don't over-create tests." So: which
unit/composable tests, which component tests, what cases each, and which
e2e flows make sense. The faucet runs against alpha-testnet — network
e2e is expensive and fragile. Probably skip in v1 and rely on smoke +
manual verification. Argue for/against.

**§8 Deploy story** — exact command the maintainer runs. Idempotency.
Where addresses get written. How the frontend picks them up.

**§9 Build & hosting** — build command, output dir, hosting recommendation
(Cloudflare Pages / Vercel / GitHub Pages) with one-line setup notes.
Any CSP / COOP / COEP requirements due to bb.js / Aztec wasm.

**§10 CI gates** — where the faucet hooks into existing root scripts.

**§11 Risks** — real risks. Name sharp edges. If you'd refuse a decision,
say so.

**§12 Non-goals** — what we explicitly are NOT doing.

**§13** — the one question you'd most want answered. Keep it sharp.

---

## DO / DON'T

DO:
- Use repo-relative paths (`packages/faucet/src/…`)
- Be specific about file paths AND file contents
- Use the actual `@aztec/wallet-sdk` and `@defi-wonderland/aztec-standards` APIs
- Propose concrete UX copy
- Cite where repo conventions live
- Be honest about uncertainty
- Default to the simplest thing that ships

DON'T:
- Add features beyond the goal (no swap UI, no transfer between users, no balance history)
- Suggest a backend
- Propose multiple networks
- Suggest custom drip amounts or rate limits
- Generate React code (this is Vue 3)
- Use emojis in code or UI
- Add CHANGELOG / docs entries that aren't strictly needed

Return the plan markdown only — no preamble, no postamble. The
orchestrator will read the file and synthesize.
