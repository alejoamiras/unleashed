# terms-1 recon

Base: `origin/main` at `fb90e36`. Two Explore agents (Sonnet): a data-flow trace and a reuse sweep. The parent
re-checked every claim the plan rests on (marked ✓). Paths are repo-relative.

## Reuse map

| Capability | Existing code | Verdict | Note |
|---|---|---|---|
| Long-form document rendering | none. No markdown dependency in any workspace (searched `marked\|markdown\|micromark\|remark\|showdown\|?raw` over `*.json/ts/vue/mjs`). The landing renders typed copy from `apps/landing/src/content.ts` | build new | A typed content module rendered with text interpolation only: no dependency, no `v-html`. `?raw` imports read empty under this app's jsdom vitest (`apps/tools/src/app.css.parity.test.ts:6`) |
| Mainnet-only code that testnet never ships | `App.vue` lazy-loads `AppShell`; `IS_MAINNET` in `src/lib/network.ts:69` | adapt | ✓ `IS_MAINNET` does NOT fold: the placeholder's text ships in today's testnet dist (scratch build, `assets/index-*.js`). ✓ A literal `import.meta.env.VITE_TOOLS_TARGET === "mainnet"` test in the importing module drops the dynamic chunk; the same flag imported from another module does not (vite 8.2.1 experiment, `lessons/phase-0.md`) |
| Build-target proof | `apps/tools/scripts/verify-build-target.ts` (target, chainId, manifest digest, exact `connect-src`); CI `.github/workflows/_build-tools.yml:49-52` per target | adapt | ✓ No content scan and no unit test today. Pattern to copy for a pure check + test: `apps/landing/scripts/dist-checks.ts` + `dist-checks.test.ts` |
| Paths | `src/composables/useShell.ts` `SECTION_PATHS` (shell only) | sidestep | Mainnet never mounts the shell; the Workers SPA fallback (`wrangler.mainnet.jsonc` `not_found_handling`) serves `index.html` at `/terms` already |
| Blocking screen / modal | `packages/design/src/ui/Dialog.vue` (Escape, scrim and × all emit `cancel`), `useFocusTrap.ts`, `Button.vue` | reuse Button; no Dialog | A full-page gate needs no modal; a modal gate would have to ignore `cancel`. No checkbox component exists |
| Browser storage | raw `localStorage`, keys `unleashed:<name>`; validated reads in `createAztecWalletSession.ts`, `useDockState.ts`; `memoryStorage()` in `src/test/crosschain.ts:116` | reuse convention | Reads can throw (private mode): `public/theme-boot.js`, `useTokenCatalog.ts` guard it |
| Content digest | `viem` `sha256` (declared dependency); bridge-core `token-list.ts` digest pin; `vite.config.ts` `createHashHex` | reuse `viem` | Synchronous, already in the bundle |
| Testing a mainnet component | `App.test.ts` mocks `@/lib/network`; `src/lib/network.test.ts` uses `vi.stubEnv("VITE_TOOLS_TARGET","mainnet")` + `vi.resetModules()` | reuse the stubEnv pattern | Needed once the switch reads the literal env value |
| Message signing | viem `signMessage` (EIP-191) for seals: `deposit-flow.ts:972`, `useBridgeBackup.ts:94` | available, not planned | Needs a connected Ethereum wallet, which the mainnet build never has today |

## Data flows (what the Privacy Policy may state)

**The mainnet build today** ✓: `App.vue` renders `MainnetPlaceholderView` only (three external links). It
makes no request beyond its own host: no node probe (`main.ts:34`), no wallet discovery, no RPC, no
token list. `MAINNET_TARGET.cspConnectSrc` is `'self' data: blob:` (`src/lib/network-targets.ts`).
`theme-boot.js` reads `unleashed:theme`; nothing writes storage. Both mainnet hosts are behind
Cloudflare Access, Foundation and Labs identities only (`apps/tools/README.md`, dashboard state).

**The app code a promoted mainnet would run** (shared with testnet; the target config picks the providers):

| Flow | Where | What leaves the browser | Config-driven? |
|---|---|---|---|
| Aztec node JSON-RPC | `createAztecNodeClient(NETWORK.nodeUrl)` in `deposit-flow.ts`, `useSend.ts`, `useHubExit.ts`, `bc/flows.ts`; boot probe `main.ts:37` | IP, timing; tx hashes, message hashes, nullifier witnesses for the user's claims | yes (`nodeUrl`; the probe also has a hard-coded mainnet skip) |
| Keyless read RPCs | `useEthereumReader.ts:22-24` | IP; `eth_getLogs`/`eth_call` filters carrying the user's L1 address and source tx hash | yes (`readRpcUrls`) |
| Token list CDN (jsDelivr) | `useTokenCatalog.ts:109` → `bc/token-list.ts` | IP; a GET of one pinned file, no user data | yes (`cspConnectSrc`) |
| Across API | `useCrossChainRoute.ts:355` → `bc/across-api.ts` `/suggested-fees` | IP; tokens, chain ids, amount, recipient, message | yes (`acrossApiUrl`; mainnet sends would need it, `:360`) |
| LI.FI API (`li.quest`) | `bc/lifi-api.ts` | nothing: no app code builds the client | n/a |
| Aztec wallet | `@aztec-labs/wallet-sdk` discovery `postMessage` + encrypted `MessagePort` (`createAztecWalletSession.ts`) | stays on the device unless the wallet sends it on: capability manifest, contracts, txs | no |
| Ethereum wallet (EIP-1193) | `useL1Wallet.ts` | signing, sends, and every read on the wallet-bound `publicClient` (`:37-45`) go through the user's wallet and its RPC | no |
| Local storage | `unleashed-bridge:journal:*` (records; public-deposit claim secrets in plain text, private ones sealed), `unleashed-bridge:seal-trust:v1`, `unleashed-bridge:token-list:v1:*`, `unleashed:preferred-wallet`, `unleashed:selected-accounts`, `unleashed:theme`, `unleashed:tools-dock*` | nothing: no code sends storage anywhere | no |
| Sealed backups | `useBridgeBackup.ts`, `bc/backup.ts`, `bc/recovery-crypto.ts` | nothing: a local download; header (format, chain, portal, bridge, direction, id, sealer L1 address) in clear, the whole record AES-GCM under a key from a wallet signature (PBKDF2-SHA-256, 600k) | no |
| Links | explorers (`lib/explorer.ts`), `scan.li.fi`, `nulo.sh`; all `rel="noopener noreferrer"` except `AztecWalletPanel.vue:98` (`noopener`; origin-only referrer) | the clicked site sees the hash or address in the link | partly |
| Public chains | `bc/send-flow.ts:216-332`, `useHubExit.ts`, `crosschain-deposit-flow.ts` | the L1 address, token, amount, portal; the Aztec recipient on public sends only; exits publish the L1 recipient and amount | no |
| Hosting | `wrangler.*.jsonc`: assets only, no `observability`/`logpush`/`analytics_engine` key | IP, user agent, path, time reach Cloudflare | dashboard state, not in the repo |

No analytics, telemetry, error reporting, cookies, sessionStorage or IndexedDB anywhere (searched
`sentry|posthog|plausible|gtag|segment|analytics|telemetry|cookie|sessionStorage|indexedDB|sendBeacon|WebSocket`
over `apps/tools`, `apps/landing`, `packages/bridge-core/src`, `packages/design/src`, tests excluded).

## Conventions to match and collisions

- Tests sit beside code (`X.test.ts`), select by `TESTIDS` (`src/lib/testids.ts`), mount with
  `@vue/test-utils`; focus-trap components need `attachTo: document.body` + `enableAutoUnmount`.
- The browser suite builds only the `local` target (`tests/browser/README.md`); the mainnet dist is
  exercised only by CI's build + `verify:build-target`.
- `App.test.ts:62-65` and `MainnetPlaceholderView.test.ts` pin "exactly three links, no button".
- sdk-1 rewrites `src/composables/*` broadly: this lane adds files under a new `src/legal/` and edits only
  `App.vue`, `App.test.ts`, `lib/testids.ts`, `scripts/verify-build-target.ts`.
- The landing links only to testnet and says "Mainnet is not open yet" (`apps/landing/src/content.ts`);
  its links are allowlisted (`LINKS`, `scripts/dist-checks.ts`).
- Open issues: none. Closed known limits: #27 only (unrelated).
