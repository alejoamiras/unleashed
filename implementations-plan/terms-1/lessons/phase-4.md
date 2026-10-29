# Phase 4: the Privacy Policy

## Claim → code (traced before the drafting rounds)

| Claim (section) | Code |
|---|---|
| The landing stores nothing in the browser | no `localStorage`, `sessionStorage`, `indexedDB`, `document.cookie` or service worker in `apps/landing/src` or `public/` (grep); `theme-boot.js` only reads `matchMedia` |
| The holding page stores nothing and calls nothing | the mainnet dist's entry and `MainnetPlaceholderView` chunk carry no storage API (grep of `dist/assets`); CSP `connect-src 'self' data: blob:` |
| The landing calls no other service | its CSP is `default-src 'none'` with only `'self'` sources, and the guard refuses a host source (`apps/landing/security-headers.ts`, `scripts/dist-checks.ts` `checkCsp`) |
| Links tell the other site at most which website, never which page | landing `Referrer-Policy: strict-origin-when-cross-origin` (`security-headers.ts`); the placeholder's links are `rel="noopener noreferrer"`; the app's `_headers` send the same policy (`apps/tools/vite.config.ts:123`) |
| What the gas flow may store | recon F5–F7: journal records (plain claim secrets for public deposits; private records sealed with readable amount and recipient; quarantine; 7-day prune), wallet choice and accounts, seal-trust, token list (one day), theme and dock |
| Services the gas flow would call | recon data-flow table: Aztec node, keyless read RPCs, the token-list CDN (one pinned file), Across `/suggested-fees`; none on mainnet today (`MAINNET_TARGET`) |
| The providers table names exactly the mainnet target's origins | `apps/tools/src/lib/privacy-providers.test.ts` |
| Backup label in clear, record encrypted | `packages/bridge-core/src/backup.ts`, `recovery-crypto.ts` (recon F7) |

## Drafting rounds

**Round 1** (gpt-6.1-sol, max, fresh session): 5 material, 2 minor. All accepted after a check.

| # | Objection | Disposition |
|---|---|---|
| 1 | A private gas record keeps its claim secret and salt readable (`send-record.ts:34-41`, `useSend.ts:848`) | demonstrated, accepted |
| 2 | Pruning runs when the journal starts; lists cap at 100; quarantine keeps the latest 100 (`useBridgeJournal.ts:462`, `journal.ts:52,445-479`); Cloudflare gives criteria, not periods | demonstrated, accepted |
| 3 | Responsibility for in-browser processing (C-40/17 *Fashion ID*); bases for the app's processing and for email; Access login records are visible to the operator | accepted |
| 4 | Transfers must name the mechanism (Art. 13(1)(f)) | accepted: DPF and its UK Extension, or SCCs with the UK addendum; a copy on request |
| 5 | UK right to complain to the controller first (UK GDPR Art. 13(2)(ca), DPA 2018 s. 164A) | accepted |
| 6 | A public deposit names the Aztec account on Ethereum at deposit (`DepositRouter.sol:283`) | accepted |
| 7 | Re-acceptance is described as existing | accepted: "once the app asks you to accept these documents" |

Residuals added to plan.md: confirm the Cloudflare plan, Access log retention and the cookie inventory
before publication; assess persistent preferences and caches under PECR reg. 6.

**Round 2** (resumed): 1 material objection. The 100 cap is not hard: cleanup keeps unfinished valid
records past it (`journal.ts:475`), and the quarantine's own cap can drop claim material
(`journal.ts:451`), so "nothing … is lost" was false. Accepted, with the user's own removal
(`useBridgeJournal.ts:657`, `discard`). Residual added: the email provider's role and transfers.

**Round 3** (resumed), the closing verdict, quoted: "No objections. The Section 3 fix landed correctly
(high confidence): it distinguishes the quarantine's hard limit from the deposit lists' soft target,
preserves unfinished records during cleanup, and acknowledges user deletion. … VERDICT: no material
objection".
