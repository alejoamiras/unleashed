---
plan: terms-1
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: completed (a1 #28, a2 #84)
base: main @ fb90e36 (a1); main @ e1d1c4c (a2 re-plan)
budget: "recon: 2 Sonnet explorers; code-review: off; Codex gpt-6.1-sol at high for audits and fix loops, at max for the drafting rounds"
---

## Outcome

- **Status:** completed; a1 merged as #28, a2 delivered in PR #84 (a draft until the owner approves its after
  shots), awaiting the orchestrator's merge. Delivers ask7.
- **Shipped:** a1, the Terms of Use and the Privacy Policy, served by the landing at `/terms` and `/privacy`
  (`packages/legal`). a2, the mainnet app's wallet-signed acceptance gate: `apps/tools/src/legal/`
  (`acceptance.ts`, `AcceptanceGate.vue`, `MainnetRoot.vue`, `testids.ts`) and their tests, `App.vue` lazily
  importing `MainnetRoot`, the dist rule in `scripts/legal-dist.ts`, and the signed policy edit (G3). The testnet
  dist stays byte-identical to `main`'s (`lessons/phase-8.md`).
- **Changed in review:** a2's Codex round 1 caught a lone gate string the testnet dist rule let through and
  asked for a root test with the check held; the Opus review gave focus back to the button after a failed
  signature and removed a dead guard; round 2 had no material findings. Deviation D19: the gate's testids left
  the global `TESTIDS`.
- **Lessons:** none promoted, because `lessons.md` is over its budget (8,365 bytes) and no entry is superseded.
  The folding rule lives in `App.vue`'s comment; the `TESTIDS` fact in `legal-dist.ts`'s rule and
  `lessons/phase-8.md`.
- **Known limits:** #82 (a copied record opens the gate in another browser), #83 (the app can ask for a document
  version the landing does not show yet, including the lazily loaded curve code across a deploy).
- **Open items:** none filed. Before the merge: `PRIVACY.updated` reads 29 October 2026, so a later merge bumps
  it first. After it: the owner's release step (P9), with G7's check that both sites serve the merge.
- **Seeds:** the `/goal` and `/loop` seeds at the end are retired. They are history, not instructions.

# terms-1: Terms of Use and Privacy Policy for the mainnet app

**The drafts this plan produces are not legal advice.** They are a starting text for the owner and the
owner's lawyer. No arc ships a document the owner has not approved. Merging deploys: Workers Builds
deploys `main` to both mainnet hosts.

| Item | Arc | PR line |
|---|---|---|
| ask7 | a2 delivers it; a1 is its prerequisite | a1 `Part of ask7`; a2 `Delivers ask7` |
| Issues | none named; none open in the area | — |

## Outcome & Quality Bar

- **For whom.** A person who opens `app.unleashed.systems` to move real funds; the owner, who carries the
  legal risk; a maintainer who later gives the mainnet target a node and APIs.
- **Excellent:**
  1. Each statement in both documents matches the code, traced in `lessons/phase-3.md` and
     `phase-4.md`. The policy's named-provider table equals the origins the mainnet target allows and
     configures, or a unit test fails (P4). The test sees origins, not request contents, so a change to
     the mainnet target also needs a fresh review of the policy (runbook line, `MAINNET_TARGET` comment).
  2. A user can read both documents before agreeing, on a phone, in short plain sentences. Capitals appear
     only where a disclaimer must stand out.
  3. Every CI build proves that the testnet and local builds ship neither document nor the gate (P2).
  4. The gate fails closed: storage that cannot be read, or a record whose signature does not check out
     over the current text, shows the gate. An acceptance holds for the rest of the session even when
     storage cannot be written.
  5. (a2) The wallet shows the user readable text that names the documents, their versions, the site and
     the account, and says it moves no funds. No wallet prompt opens until the user presses the button.
- **Good enough.** The record stays in the browser: the operator holds no proof of acceptance (I3, G5).
  English only. No "what changed" view between versions. An ERC-1271-only account cannot accept (G4).

## Assumptions

**Facts** (verified; detail in `recon.md`)

- F1. The mainnet build renders `MainnetPlaceholderView` and nothing else (`apps/tools/src/App.vue:16`).
  Its CSP `connect-src` is `'self' data: blob:` (`MAINNET_TARGET`, `src/lib/network-targets.ts`), and
  `verify-build-target.ts` fails a dist whose `connect-src` differs.
- F2. Both mainnet hosts sit behind Cloudflare Access, Foundation and Labs identities only
  (`apps/tools/README.md:162`, dashboard state). Access sets its own `CF_Authorization` cookie.
- F3. `IS_MAINNET` (`src/lib/network.ts:69`) does not fold: the placeholder's text ships in today's
  testnet dist. An unused `TESTIDS` property (`tl-add-token-status`) ships there too.
- F4. With vite 8.2.1, a module-scope `const X = import.meta.env.VITE_TOOLS_TARGET === "mainnet"` in the
  module that holds `import()` removes that chunk from other targets; the same flag imported from
  another module does not (`lessons/phase-0.md` E1).
- F5. The app's source writes only `localStorage` (keys in `recon.md`) and sets no cookie; no workspace
  has a markdown dependency, analytics, telemetry or error reporting. The testnet bundle also carries
  bb.js's IndexedDB store (`keyval-store`) and its CRS hosts (`contract-instance-registry-*.js`).
- F6. The journal keeps plain-text claim secrets for public sends and fuel, and plain-text display copies
  of a private send's recipient and amount (`bc/journal.ts:9-11,86,116`). It parks invalid entries under
  a quarantine key (`:445-451`) and prunes completed records after 7 days (`:629-631`).
- F7. Backups are local downloads (`useBridgeBackup.ts:40-48`): a clear header (chain, portal, bridge,
  direction, id, the sealer's L1 address) and the record under AES-GCM with a key from a wallet signature
  (`bc/backup.ts`, `bc/recovery-crypto.ts`).
- F8. No app code builds a LI.FI API client. The Across API is called only when the target sets
  `acrossApiUrl`, which a mainnet cross-chain send needs (`useCrossChainRoute.ts:355-360`). Reads on the
  wallet-bound L1 client go through the user's wallet and its RPC (`useL1Wallet.ts:27-45`).
- F9. Privileged powers: the factory owner pauses L1 deposits and withdrawals (`PortalFactory.sol:62`);
  the hub guardian pauses exits, never claims (`token_bridge_hub/src/main.nr:57-63`); the router owner
  sweeps balances the router holds outside a call (`DepositRouter.sol:190-195`). Portals release escrow
  only through `withdraw` against an L2→L1 message (`TokenPortalImpl.sol:88`).
- F10. The browser suite builds only `local`. CI builds testnet and mainnet and runs `verify:build-target`
  on each (`_build-tools.yml:49-52`). The host check is PROD-only (`build-integrity.ts:20-21`), so a
  mainnet dev server renders on localhost.
- F11. `viem` exports a synchronous `sha256` and is a dependency of `apps/tools`. `new URL("data:")` and
  `new URL("blob:")` parse, with origin `"null"`.
- F12. The landing links only to testnet and says "Mainnet is not open yet" (`apps/landing/src/content.ts`).
  (Superseded by a1: the landing's footer links both documents.)

**Facts for the a2 re-plan** (verified on `e1d1c4c`; detail in `recon.md` § a2)

- F13. The approved Terms already describe this method: "you sign its acceptance message with your
  Ethereum wallet, and the message names the version you accept" (`packages/legal/src/terms.ts:17`).
- F14. The approved Privacy Policy says the holding page stores nothing in the browser
  (`privacy.ts:39`). A gate in front of it makes that false, so a2 must edit the policy (G3).
- F15. The only `window.ethereum` accessors are private, in composables (`useL1Wallet.ts:23-26`).
  `isUserRejection` (`src/lib/wallet-errors.ts:13-24`) is reusable; its one import imports nothing.
- F16. viem 2.57.1's `verifyMessage` checks an EIP-191 signature locally (ECDSA recovery, no client) and
  returns a Promise. Run here, awaited: true on the signed text, false on a changed text, and a rejection
  on a malformed signature. An unawaited result is a truthy Promise.
- F17. EIP-191 `personal_sign` carries no chain id, so signing needs no network switch. An injected
  wallet's calls are not page fetches, so the mainnet CSP (`connect-src 'self' data: blob:`) is unchanged.
- F18. The browser fixture's `personal_sign` returns a real, recoverable signature and supports
  `rejectNext` (4001) (`tests/browser/fixtures/l1-wallet.ts:267,328-336`).
- F19. Every change to `packages/legal` publishes on the landing when it merges (a1, D11).

**Inferences** (unverified)

- I1. F4's fold also holds in `App.vue`. The P2 rule proves it on every build. Fallbacks in order: a plain
  `<script>` block (module scope, E1's shape), then a per-target `resolve.alias` to an empty module.
- I2. The documents say what the mainnet app does today (a holding page) and describe the bridge features
  as applying once bridging opens. Opening bridging changes that sentence and the provider table, so
  the digest changes and every user is asked again.
- I3. Clear notice of linked terms plus an unambiguous act (an unticked box, then a click) is the form
  courts enforce most reliably: *Meyer v. Uber*, 868 F.3d 66 (2d Cir. 2017) and *Berman v. Freedom
  Financial Network*, 30 F.4th 849 (9th Cir. 2022) on notice and assent; *Nguyen v. Barnes & Noble*,
  763 F.3d 1171 (9th Cir. 2014) refused a browsewrap. Confidence: moderate. A record kept only in the
  browser gives the operator no proof that a given person agreed. That is an accepted limit: keeping
  proof needs a server with personal data (C4).
- I4. EU and UK consumer law limits disclaimers and caps (Directive 93/13/EEC; UK Consumer Rights Act
  2015 s. 62), and an EU court may not rewrite an unfair term (C-618/10). So the Terms list the
  carve-outs explicitly; no summary to the owner promises enforceability.

- I5. (a2) Wallets display a `personal_sign` message as text, and some hardware wallets do so only for
  printable ASCII, which is why the message is ASCII-only. A wallet may also shorten it or add warnings, so
  the copy promises only what the app asks the wallet to show. Confidence: moderate; no named wallet was
  tested.
- I6. (a2) An ERC-1271 signature cannot be checked by ECDSA recovery; checking it needs a chain call, and
  the mainnet build has no read path (F1). An account that signs with its own key, an EIP-7702 delegated
  one included, recovers and passes. Confidence: high for the mechanism; how many mainnet users hold an
  ERC-1271-only account is unknown.

**Asks.** A1–A14 and C1–C8 are answered (`OWNER-ASKS.md`, decision pages 1 and 4); C5 (the layout) never
was, so G1 carries it. a2 is built only after the owner signs G1–G4 on a page; G5–G7 have a "ships now"
form and do not block it.

## Architecture & Implementation

**a1, as built** (D11; the file map is under the ledger's "Deviations in a1"). `packages/legal` holds the
documents as closed typed data (`document.ts`, `terms.ts`, `privacy.ts`) and their public URLs (`site.ts`).
The landing renders static `/terms` and `/privacy` through `esc()`. In `apps/tools`, `App.vue`'s literal
define test lazily imports `MainnetPlaceholderView`, which links to the landing's pages; nothing under
`src/composables/` changed (sdk-1 rewrites it). The original file map (an in-app `LegalPage`, a path
router in `MainnetRoot`) and the drafting outlines for P3 and P4 were superseded by D11 and by the merged
text; both are in git history.

**Dist rule.** A mainnet dist carries both document URLs (from a2, also both document ids). A testnet or
local dist carries no URL, no document id, and no `MainnetPlaceholderView` chunk (from a2, no `MainnetRoot`
chunk either). One problem line per broken expectation, naming the matching file.

**Provider pin (P4): an allowlist consistency check.** Origins of every `https:`/`wss:` source in
`MAINNET_TARGET.cspConnectSrc`, plus those of `nodeUrl`, `readRpcUrls`, `acrossApiUrl` and
`webWalletUrls`, must equal the non-null `origin` values in the providers block. Both sets are empty
today. The hosting row is always present. The pin cannot see request contents or wallet-routed calls
(F8); the code trace covers those.

**Version (a1, kept by a2).** `version(doc) = sha256(stringToBytes(JSON.stringify(doc)))` (viem), computed
at module load. Any edit re-asks (P1-15). No test can force a fresh "Last updated" date (a pin of date
and digest passes when only the digest is updated), so every text edit updates `updated` and the fix
loop checks it. The record and the gate: § Arc a2 design.

**Trade-offs:** ledger D1–D17.

## Arc a2 design: wallet-signed acceptance (re-plan)

Owner decisions this arc builds on (the visible budget): **P1-14 Option B**: "Sign a message with their
wallet." (note: a decision page showing how it looks before it is built). **P1-15 Option A**: "After any
change to either document." **P1-16 Option A**: "Now, behind the login wall." The layout, every string and
the signed text are G1–G4, signed on decision page 11 (P11-01 to P11-04, each Option A; G5–G7 are P11-05
to P11-07, ledger D18).

**What is signed: EIP-191 plain text (`personal_sign`)**, ASCII only, from one pure function
`acceptanceMessage(origin, account)`; the dates, URLs and digests come from `@unleashed/legal`:

```
Unleashed: accept the Terms of Use

I agree to the Unleashed Terms of Use, and I have read the Privacy Policy.

Terms of Use, updated 29 October 2026
https://unleashed.systems/terms
Version 0xa7898348…c9811331            (the full 32-byte digest)

Privacy Policy, updated 29 October 2026
https://unleashed.systems/privacy
Version 0x27f0fb8a…e1be7354

Site: https://app.unleashed.systems     (location.origin)
Account: 0x…                             (checksummed)

Signing is free. It is not a transaction and moves no funds.
```

Why text and not EIP-712 (ledger D12): an EIP-712 domain has no field the wallet checks against the
requesting origin, so "a domain bound to the origin" is a string the wallet shows and never verifies, as
in text; the wallet shows the requesting origin itself either way. Its `chainId` is optional, but with one
MetaMask refuses unless the wallet is on that chain, and without one the domain is a name and a version
that add nothing to text. Nothing ever parses the record (no contract, no server): the verifier rebuilds
the exact text, so structure buys nothing. Typed-data requests are the form Permit and Permit2 drainers
use, and a gate would make that prompt routine for every visitor; a text message authorizes no token
transfer in any contract we know of. The repository's precedent is text (`recoveryKeyMessage`). Not
EIP-4361 either: conforming wallets check its origin, but they title it a sign-in, which misnames assent,
and its nonce exists for a relying party to check, which this app does not have. The first line must never
match EIP-4361's opening (`<domain> wants you to sign in with your Ethereum account:`).
What the wallet does with the text varies (I5): the app asks it to show this exact text, nothing more.

**Where it is kept.** `localStorage["unleashed:legal-acceptance"] =
{"v":1,"account":"0x…","signature":"0x…","terms":"0x…","privacy":"0x…"}`, on the device only (G5). Each
mainnet host is its own origin, so a user signs once per host.

**What a later visit checks** (`async readAcceptance(getStorage, origin)`; no wallet, no prompt; the root
stays in `checking` until it settles):

1. Reading, parsing and the shape succeed: the parsed value is a plain object (not null, not an array),
   `v === 1`, `account` matches `^0x[0-9a-fA-F]{40}$`, `signature` `^0x[0-9a-fA-F]{130}$`, each digest
   `^0x[0-9a-f]{64}$`. Else `none`. `getStorage` is `() => window.localStorage`, so a throwing getter is
   `none`. The same check runs on a record before it is stored.
2. Both digests equal the current ones; else `changed`. This step proves no earlier acceptance (a junk
   record with old digests reads `changed`), so the re-ask copy claims none.
3. `(await verifyMessage({ address: account, message: acceptanceMessage(origin, account), signature }))
   === true`, inside `try`/`catch` (a rejection counts as false); else `none`. The text is rebuilt from the
   current documents and this page's origin, so a record for another site or version, or with any field
   edited, fails.

**Signing** (`signAcceptance(provider, origin)`, only on the button): `eth_requestAccounts`, the first
account through `getAddress`, the text, `personal_sign` with `[stringToHex(text), account]`, then
the awaited `verifyMessage` on the result before anything is stored. That check refuses a wallet that
signed with another account or returned a signature recovery cannot check, an ERC-1271 one included (I6,
G4). `recordAcceptance` ignores a failed write; `MainnetRoot` holds `accepted` for the session.

**States** (strings G1, G4): `checking` renders nothing (milliseconds), then `ask`, or `reask` when step 2
said `changed`. A press moves to `pending` (button disabled and `aria-busy`), then `accepted` (the
placeholder), `refused` (`isUserRejection`), `busy` (EIP-1193 `-32002`: the wallet already holds a request
from this site, which a reload does not clear), `no-wallet` (no `window.ethereum` at press time) or
`failed` (anything else). Each of the last four keeps the button, and a press retries. `pending` has
no timer: its line tells the user to answer or cancel in the wallet, which ends it as `accepted` or
`refused`. Another tab learns of an acceptance on its next load.

**Version change (P1-15 A).** Any edit to either document changes its digest. The next load reads `changed`
and shows the re-ask screen; a new signature replaces the record. A refusal leaves the old record and the gate.

| File | Change |
|---|---|
| `apps/tools/src/legal/acceptance.ts` | new: `DIGESTS`, `acceptanceMessage`, `readAcceptance`, `signAcceptance`, `recordAcceptance`, `injectedProvider()` (the one `window.ethereum` read) |
| `apps/tools/src/legal/AcceptanceGate.vue` | new: G1's screen and its states; emits `accepted` |
| `apps/tools/src/legal/MainnetRoot.vue` | new: `readAcceptance` once on mount; the gate until accepted, then `MainnetPlaceholderView` |
| `apps/tools/src/App.vue` | edit: the literal define test gates `import("./legal/MainnetRoot.vue")` instead of the placeholder |
| `apps/tools/src/legal/testids.ts` | new: the gate's testids, kept out of the global `TESTIDS` (D19) |
| `apps/tools/scripts/legal-dist.ts` + test | edit: a mainnet dist also carries both document ids (the gate imports the documents); other targets also refuse a `MainnetRoot` chunk |
| `apps/tools/src/lib/network-targets.ts` | edit: the `MAINNET_TARGET` comment's "no wallet transport" becomes "no page fetch; the gate's two calls go to the injected wallet" |
| `packages/legal/src/privacy.ts` | edit: G3's sentences and a new `updated` date (publishes on the landing, F19) |

## Security & Adversarial Considerations

- **Threat model.** The documents are committed, trusted data. The surface is the renderer (XSS: text
  interpolation only, tested in P1), hidden text (bidi and zero-width characters U+200B–U+200F,
  U+202A–U+202E, U+2066–U+2069, U+FEFF, rejected in P1), the gate's storage, the build split (the P2 rule
  in CI on every target), and the documents' truth (traces, Codex rounds, the P4 pin, the P6 placeholder
  guard, draft PRs until the owner approves).
- **The gate is not access control.** The user owns the browser and can write the record by hand. The gate
  records assent; no code may treat it as a security check. It fails closed (a throwing storage getter or
  read, a malformed record, an old digest). From a2 it holds an address, a signature and two digests,
  which G3 declares (§ a2, the signed record).
- **Unchanged:** the CSP, `frame-ancestors 'none'` on every path, and the dependency set (none added).

**a2, the signed record.** The attacker classes: a script on another origin, a phishing clone of the app,
anyone with write access to the user's browser storage (the user, an extension, code already running in
this origin), a wallet that misbehaves. Paths:

- **Replayed signature** (demonstrated by construction): someone copies another person's valid record into
  this browser's storage for the same origin; step 3 passes and the gate opens on an assent that names the
  other account. It needs write access to this origin's storage, which only the user or code already
  running here has; no funds move and no boundary is crossed. Known limit, as "the gate is not access
  control": with a signature, forging a record is the same act as signing with any key.
- **Cross-origin** (traced, corrected in audit): `Site` names the site the page claims to be, not where the
  signing happened. An honest page on another origin (the other mainnet host, a dev server) builds a text
  that fails step 3 here. A clone can ask for the exact text naming `app.unleashed.systems`, while the
  wallet shows the clone's real origin; that signature verifies here, but only once someone with write
  access to this origin's storage imports it, which is the replay path above. Storage is per origin, so no
  other site reads or writes the record. Known limit.
- **Old version** (traced): both digests are in the signed text; an old record reads `changed` and re-asks,
  and a signature over one version can never verify as another.
- **Storage tampering** (traced): an edited field fails the shape or step 3; a removed record re-asks; a
  throwing storage reads `none`. The record holds an address and a signature, personal data the policy
  must declare (G3); it never leaves the device.
- **The signature reused elsewhere** (exploitability unknown, no known consumer): the EIP-191 prefix makes it
  neither a transaction nor an EIP-712 message, and the text is not EIP-4361, so no sign-in verifier takes it.
- **A wallet that signs with another account or returns junk** (traced): checked before storing; `failed`.
- **The phishing habit** (C4's concern): the prompt opens only on a press, after the screen says what the
  wallet will show, and the text says it moves no funds. Never on page load.
- **Version skew** (plausible): the landing (where the user reads) and the app (whose digests the user
  signs) deploy separately from one commit, in either order. Between the two deploys, and for as long as a
  failed deploy or an open tab lasts, the user can sign a digest of a text the landing does not show; two
  edits on one day share a date. A view of the bundled text in the app would close it, but it is a second
  renderer (D11 L) and new visible UI. The owner decides (G7); ships now: the limit, with the release step
  checking both Workers serve the merge commit. Known limit, filed at close-out.
- **Injection:** the text holds only `location.origin` and a checksummed address; the screen renders by
  interpolation. No new dependency; viem is already one.

## Phases

UI impact lines quote the recorded owner decisions: a1's are decision pages 1 and 4 (P1-01 to P1-17,
P4-01 to P4-03); a2's are P1-14 B, P1-15 A and P1-16 A, quoted in § Arc a2 design, and G1–G4 once signed.
Every visible part waits for the named entry. Testnet: none, in every phase.

### Arc a1: the documents, rendered on mainnet only

Done and merged as #28; each phase's steps and gate are in git history and its log in `lessons/`.

- **P1 ✓** the mainnet root and renderer (later moved to the landing, D11); hidden-character test.
- **P2 ✓** the dist rule in `verify:build-target` (`lessons/phase-2.md`).
- **P3 ✓** the Terms, three Codex rounds at `max` to no material objection (`lessons/phase-3.md`).
- **P4 ✓** the Privacy Policy and the provider pin, three Codex rounds (`lessons/phase-4.md`).
- **P5 ✓** the code fix loop, screenshots, draft PR; `e2e:tools` ran in CI only (`lessons/phase-5.md`).
- **P6 ✓** the owner's answers (decision pages 1 and 4), the `[[OWNER` refusal, the re-trace, two code rounds
  (`lessons/phase-6.md`).

### Arc a2: the signed acceptance gate (starts after the owner signs G1–G4)

Design: § Arc a2 design. Every phase assumes F13–F19 and I5–I6; nothing else is assumed.

**P7 ✓: the record and the signed text.** UI impact: none on screen; the text is G2, verbatim.

1. Merge `origin/main`. Write `acceptance.ts`.
2. `acceptance.test.ts`, with real signatures from `privateKeyToAccount(...).signMessage`:
   - The text equals G2 for a fixed origin and account; it is ASCII-only (control: an inserted "é" fails
     the check); its first line does not match EIP-4361's opening.
   - `readAcceptance`: empty → `none`; a signed record → `accepted`; a changed terms or privacy digest →
     `changed`; the same record read under another origin → `none`; an edited account or signature →
     `none`; bad JSON, `null`, an array, a wrong field type, a short or upper-case digest, `v` ≠ 1, a
     throwing `getItem`, a throwing storage getter → `none`. A `verifyMessage` that resolves false after a
     delay, or rejects, → `none` (control: the same record with a true result → `accepted`).
   - `signAcceptance` with a fake EIP-1193 provider: success returns a record that reads `accepted`; a
     signature by another key (the wallet switched accounts between the two calls) → throws, nothing
     stored; a 4001 on `eth_requestAccounts` or on `personal_sign` → the error passes `isUserRejection`; a
     `-32002` → classified `busy`; an empty account list → throws.
   - A throwing `setItem` does not throw.
   - An old record relabelled with the current digests, its old signature kept, → `none` (only step 3
     can refuse it).

Gate: `bun run lint && bun run typecheck:all && bun run --cwd apps/tools test`, exit 0 (lint, typecheck,
unit).

**P8 ✓: the screen, the root, the policy edit.** UI impact: G1–G4 exactly, and G3's policy text.

1. Build `AcceptanceGate.vue` and `MainnetRoot.vue`; edit `App.vue`, `testids.ts` and the
   `MAINNET_TARGET` comment.
2. Extend `legal-dist.ts`: a mainnet dist without a document id fails; a testnet dist with a `MainnetRoot`
   chunk fails; a clean control per target.
3. Apply G3 to `privacy.ts` with the merge day's UTC date as `updated`.
4. Tests: `checking` renders nothing; `ask` hides the placeholder; a `changed` record shows the re-ask
   heading; a press shows `pending` (button disabled, `aria-busy`, G4's status line); success shows the
   placeholder and writes the record; `refused`, `busy`, `no-wallet` and `failed` each show their G4 line
   and keep the button; a press after a refusal signs; focus starts on the heading; the keyboard alone
   completes it; `checking` that settles late still shows nothing before it settles; the provider sees no
   request before the first press; a good signature with a throwing `setItem` opens the placeholder, and
   a remount with empty storage shows the gate again. `App.test.ts`: replace the placeholder's mock, load
   counter and rendering assertions with `MainnetRoot`'s.
   Then mainnet loads `MainnetRoot` and never the shell; testnet never loads `MainnetRoot`.

Gate: the P7 gate, then `bun run --cwd apps/tools build:testnet && bun run --cwd apps/tools
verify:build-target testnet && bun run --cwd apps/tools build:mainnet && bun run --cwd apps/tools
verify:build-target mainnet`, both printing ✓ (adds build), then `bun run build:landing` exit 0
(its guard refuses an owner's blank and checks every page).

**P9 ✓: review, run, PR, close-out.**

1. The Codex fix loop on the a2 diff (Post-implementation).
2. Claim a port: `bun apps/tools/scripts/e2e/resolve-ports.ts <state-dir> terms-1-gate $$`. In `apps/tools`,
   start `TOOLS_DEV_PORT=<port> bunx vite --config vite.mainnet.config.mts` in its own process group.
3. Drive it with Playwright, `PLAYWRIGHT_BROWSERS_PATH` unset. Inject a test EIP-1193 provider (an init
   script shaped like F18's fixture, with a viem account; never committed). Accept by keyboard, then
   reload: no gate. Change a stored digest: the re-ask. Empty storage: the gate. Refuse: the refusal line.
   Answer `-32002`: the busy line. Take every state at 1280 and 390 px, light and dark, and compare each
   with the signed mocks. Stop the server by its process group and release the port with `--release`.
   Log the run in `lessons/phase-9.md`.
4. Draft PR; ready only after the owner approves the final screenshots (P1-16 A: live at merge).
5. The close-out.

Gate: `bun run audit:tools && bun run test:all` exit 0, the P8 build commands, and `bun run e2e:tools`
exit 0 (`App.vue` is the testnet shell's entry too; where the worktree cannot boot the sandbox, CI's
`tools-e2e-status` is that layer, as in P5).

**Owner's release step (each arc).** After the merge deploys, open `/` on both mainnet hosts in a browser
logged in through Access, with a real Ethereum wallet: sign, reload, and confirm no second prompt. Confirm the
landing and the app both serve the merge commit (G7), and check the landing `/privacy` date. This is the only
check of the production bundle on its host (F10).

## Delivery

| Arc | Phases | Branch | Base | PR title | code-review |
|---|---|---|---|---|---|
| a1 | P1–P6 | `worktree-terms-1` (carries the plan commit) | `main` | `feat(tools): add the mainnet terms of use and privacy policy` | off |
| a2 | P7–P9 + close-out | `worktree-terms-1` (a1 squash-merged as #28; the branch carries `main` and the a2 re-plan) | `main` | `feat(tools): ask for a wallet-signed acceptance of the mainnet terms` | off |

- A PR opens only after its gates pass and its Codex loop converges. The body gives what changed and why,
  each validation with its result, the screenshots, `Part of ask7` or `Delivers ask7`, and the owner
  decisions it applies, quoted.
- Both PRs open as drafts and become ready only after the owner approves the final screenshots and text
  of that revision (P6 step 5, P9), so no standing merge policy can ship placeholders or unapproved
  screens. The orchestrator merges.
- The close-out is a2's last commits; if the owner drops a2, it is a1's after P6.
- Parallelism: none. Each arc waits on the owner, and a2 builds on a1.

## Decision ledger

| # | Question | Chosen | Rejected, and why |
|---|---|---|---|
| D1 | Document format | typed TS data, text interpolation | Markdown + a dependency: a new dependency under the 7-day gate and a `v-html` sink. Markdown + our own converter: a parser and a build plugin to maintain for two files |
| D2 | Testnet ships nothing | a module-scope literal define test in `App.vue`, proven by the dist rule | `IS_MAINNET` does not fold (F3); a per-target alias is more config, kept as the second fallback |
| D3 | Version | sha256 of the document data; the date is a review item | a hand-bumped version: an edit without a bump would never re-ask. A `{ updated, digest }` pin: passes when only the digest is updated |
| D4 | Provider truth | the pin to the target's allowlist and endpoints, plus a code trace | a prose list alone drifts silently |
| D5 | What the documents describe | today's holding page plus the bridge features "once bridging opens" | the placeholder alone: obsolete at launch; the full app in the present tense: false today |
| D6 | Arcs | the orchestrator's a1/a2; a1 a draft until P6 | Outline B |
| D7 | Method | the owner chose the wallet signature (P1-14 B) over the recommended click-through | — the owner decides |
| D8 | Browser coverage | jsdom tests + the dist rule as the regression layer; a scripted dev-server run per arc; the owner's post-deploy check | a committed mainnet browser spec: the browser suite builds only `local`, and the production bundle refuses localhost by design (F10), so a spec would need a new target in the harness to test what jsdom already proves |
| D9 | Drafting effort | Codex at `max` until no material objection; a repeated, reasoned-against point is a recorded disagreement | a fixed round cap: the lane brief says rounds run until no material objection |
| D10 | Legal testids | `src/legal/testids.ts` | the global `TESTIDS`: its unused keys ship to testnet (F3) |
| D11 | Where the public reads the documents (C8) | G: a data-only package `packages/legal` (`@unleashed/legal`) holds the documents, their ids and their public URLs; the landing renders static `/terms` and `/privacy` (CSS and theme boot, no script); the mainnet placeholder links there; a2 imports the package for the digests. Codex and Opus both chose G | C: an Access bypass on the app host for `/terms`, `/privacy` and `/assets/*` (a dashboard dependency, and it exposes the walled bundle). H: the documents in the landing until a2 (a move in a2, and a2's gate would import from an app). L: a renderer per app (two renderers of one text) |

| D12 | What is signed (a2) | EIP-191 plain text, ASCII, claimed site, account and both digests in the text | EIP-712: no origin check, an optional `chainId` that either forces a chain or adds nothing, structure nobody parses, the drainers' request form (§ Arc a2 design). EIP-4361: titled a sign-in; its nonce is for a relying party this app does not have |
| D13 | Later visits (a2) | re-verify the stored signature locally on every load (awaited) | store digests only and trust them: any hand-written record passes, and a junk record cannot be told from a real one. A chain call for ERC-1271 signatures: the mainnet build has no read path (F1), and adding one adds a provider to the policy |
| D14 | Wallet access (a2) | two raw EIP-1193 calls in `src/legal/acceptance.ts` | `useL1Wallet`: a composable sdk-1 rewrites, and it builds a wallet client, listeners and chain switching the gate never uses |
| D15 | Where the signature is kept (a2) | the user's browser only | a server copy: new persistence and personal data, and the approved policy says no server receives data. The owner's call (G5) |
| D16 | ERC-1271 signatures (a2) | refused with G4's `failed` line | accept unverified: a junk signature would then pass. Verify on chain: D13's reasons |
| D17 | Version skew between the landing and the app (a2) | a known limit, put to the owner (G7) | a bundled document view in the app: a second renderer (D11 L) and new visible UI. Versioned document URLs: a publication and retention contract |
| D18 | The owner's answers (a2) | decision page 11, each Option A: P11-01 "Approve the agree screen as shown."; P11-02 "Approve the wallet message as shown."; P11-03 "Approve the Privacy Policy edit."; P11-04 "Approve the failure lines as shown; smart-contract accounts that need the chain to check stay out for now."; P11-05 "No copy: the signature stays in the person's browser."; P11-06 "One acceptance per browser for now; decide per-account when the gas flow opens."; P11-07 "Accept it for now, with a check after each merge that both sites serve the merged version." | — the owner decides |
| D19 | The gate's testids (a2, a deviation from the file map) | `apps/tools/src/legal/testids.ts` (`GATE_TESTIDS`), imported only by mainnet code | the global `TESTIDS` (the plan's map, D11's reason): it ships whole to every build, so the testnet dist would change by four strings, and the testnet build must stay byte-identical (proved in P8) |

**Deviations in a1 (D11).** The file map's `LegalPage.vue`, `MainnetRoot.vue` and `testids.ts` were
built in P1 and removed once C8 moved the pages to the landing. The a1 file map is now:

| File | Change |
|---|---|
| `packages/legal/` | new: `document.ts` (types, ids), `terms.ts`, `privacy.ts`, `site.ts` (origin, paths, URLs), the hidden-character test |
| `apps/landing/terms.html`, `privacy.html`, `src/legal-markup.ts`, `src/styles/legal.css` | new: the two pages, rendered at build time through `esc()` |
| `apps/landing/vite.config.ts`, `scripts/dist-checks.ts`, `src/content.ts`, `src/markup.ts`, `tests/server/static-server.ts`, `tests/browser/*` | edit: three HTML inputs; every page checked; footer links; `/x` served from `x.html` as the Worker does |
| `apps/tools/src/App.vue` | edit: the literal define test now gates a dynamic import of `MainnetPlaceholderView` |
| `apps/tools/src/views/MainnetPlaceholderView.vue` | edit: a second row, "Terms of Use", "Privacy Policy", to the landing's pages (C3 (a), as C8's "the mainnet app linking there") |
| `apps/tools/scripts/legal-dist.ts` | the rule becomes: a mainnet dist carries both document URLs; a testnet or local dist carries neither, no document id, and no `MainnetPlaceholderView` chunk |
| CI filters | `packages/legal/src/**` and `packages/legal/package.json` join the pr-quick `tools` and `landing` filters and the pr-tools-e2e filter |

The placeholder's new testid joins its two existing keys in the global `TESTIDS` (it carries no legal
text, so D10's leak does not apply). CI runs `verify:build-target` for testnet and mainnet only; the
local dist relies on the same literal fold. One Privacy Policy covers the landing and the mainnet app, and says it does not cover testnet. "The
landing stores nothing in your browser" becomes a standing promise: a script on the landing that stores
anything is a policy change. The `[[OWNER` refusal (P6 step 3) lands in the landing's dist check with
the A11 date fill, in the same commit: before it, the draft status is what keeps the blank off the
public landing. A deploy of each Worker is independent, so the owner's release step opens the landing's
`/terms` and `/privacy` as well as the app's `/`.

**Residuals for the owner's lawyer** (the documents do not resolve them): the documents name no person
and no address (A1/A2), which leaves the UK and EU GDPR identity duty (Art. 13(1)(a)) and a possible
Art. 27 representative open, and the E-Commerce Regulations 2002 reg. 6 ask for a name and a geographic
address; a zero liability cap (A8) may not hold under the UK Consumer Rights Act 2015 and UCTA 1977; LCIA
costs above the £5,000 floor face fairness review; a wallet signature identifies a key, not a person.
Before publication: confirm the Cloudflare plan, the Access log retention and the cookie inventory, the
email provider's role and transfers, and assess persistent preferences and caches under PECR reg. 6.

**Outline B (competing, a1).** Markdown under `docs/legal/` through a mainnet-only vite plugin: easier for a
lawyer to edit, but a converter, a plugin and a raw-HTML policy to maintain, and the gate would still need a
digest the plugin emits. Rejected for typed data (D1, D6).

## Audit verdicts

**Round 1, Codex** (gpt-6.1-sol, high, fresh session): conditional approve. All findings were verified
in the tree first.

| # | Finding | Disposition |
|---|---|---|
| 1 | "No cookies" is false under Access (high) | accepted: F2; Privacy §2; A10 rewritten |
| 2 | Governing law does not decide GDPR scope (high) | accepted: A12 asks establishment and markets; Privacy §10 keeps the GDPR sections |
| 3 | P4 cannot prove the whole privacy invariant | accepted: renamed an allowlist check; endpoints added; runbook line and comment |
| 4 | The policy mixes today and later | accepted: D5, I2 |
| 5 | Global `TESTIDS` leaks legal strings to testnet | accepted, demonstrated (F3): D10 |
| 6 | jsdom overclaims; add a mainnet browser smoke | partly: throwing storage getter tested; scripted dev-server run per arc; owner's post-deploy check. Committed browser spec rejected (D8) |
| 7 | Owner guidance overstates protection | accepted: A8, C1 lines 3 and 13, I3, I4 softened |
| 8 | Local-data wording too loose | accepted: F6, F7; Privacy §3, §8 |
| 9 | Outline B's rejection used weak arguments | accepted: ledger text corrected; A kept |

**Round 1, same-family Plan agent** (Opus 5.5): conditional approve.

| # | Finding | Disposition |
|---|---|---|
| 1 | Pause and owner powers undisclosed; "never holds funds" false (high) | accepted, demonstrated (F9): Terms §4, A13, C5 copy |
| 2 | Cloudflare features beyond logs | accepted: A9 widened; "our host may set security cookies" |
| 3 | The policy says nothing about RPC, routing and bridge APIs | accepted: Privacy §6 by kind |
| 4 | Nothing stops a1 merging with placeholders | accepted: draft PR until P6 |
| 5 | GDPR tied to governing law | accepted (as Codex 2) |
| 6 | Ties to Nulo or Aztec unasked | accepted: A14; Terms §2 |
| 7 | sdk-1 makes the traces stale | accepted: P6 step 1. The storage list has no pin: a known limit, filed at close-out |
| 8 | The pin fails on `data:`/`blob:` | accepted, demonstrated (F11): only `https:`/`wss:` sources |
| 9 | Drafting rounds never stop | partly: D9 |
| 10 | "Last updated" can go stale | partly: a review item; the proposed pin cannot enforce it (final pass, finding 4) |
| 11 | The savings clause alone is weak | accepted: explicit carve-outs, Terms §9 |
| 12 | `<script setup>` differs from E1 | accepted: I1 fallback order |
| 13 | Hidden characters in drafted text | accepted: P1 test |
| — | "Unused `TESTIDS` keys are dropped" | rejected: `tl-add-token-status` ships unused in the testnet dist |
| — | F5: bb.js IndexedDB and CRS hosts in the bundle | accepted: F5, P4 step 1, Privacy §3 |

**Final fresh Codex pass** (gpt-6.1-sol, high, new session, with the ledger and the disputed points):
conditional approve. D8, D9, D10, D5 and the `TESTIDS` rejection held.

| # | Finding | Disposition |
|---|---|---|
| 1 | P6 can finish with a material drafting objection (high) | accepted: P6 step 4 reruns the done rule and the fix loop |
| 2 | No approval checkpoint for the final screenshots (high) | accepted: both PRs stay drafts until the owner approves that revision |
| 3 | C6 and C7 alternatives have no branch | accepted: C6 "important only" is a plan change (P7); C7 "later" holds a2's draft (P9) |
| 4 | The `{ updated, digest }` pin cannot enforce the date (reproduced) | accepted: dropped; a review item (D3) |
| 5 | `e2e:tools` missing from the pre-PR gate | accepted: P5 gate |
| 6 | "Token-list CDN: IP only" understates | accepted: Privacy §6 |
| 7 | C4 hides the click-through's evidence limit below Detail | accepted: moved above Detail |

Resumed verification round: conditional approve, one finding: the Post-implementation command still made
a2's PR ready. Fixed (`--draft` for both arcs). Second resumed round: **approve** (final verdict).

**a2 re-plan, Codex round 1** (gpt-6.1-sol, high, fresh session): conditional approve. Each claim was
checked in the tree first; #7 against `terms.ts:67`, #3 by the awaited run behind F16.

| # | Finding | Disposition |
|---|---|---|
| 1 | Users can sign a version the landing does not show (version skew; a failed deploy prolongs it) | accepted as a known limit put to the owner (G7, D17); the bundled in-app view rejected (D11 L, new UI) |
| 2 | Cross-origin protection overstated: a clone can request the exact text naming the real site | accepted, demonstrated: Security and G2 Detail corrected; it reduces to the replay limit |
| 3 | `verifyMessage` returns a Promise; an unawaited check admits junk | accepted: F16, step 3, delayed-false and rejection tests in P7 |
| 4 | A reload does not clear a pending wallet request (`-32002`) | accepted: the `busy` state and line (G4), tests in P7 and P8; no timer |
| 5 | I5 and G2 promise wallet displays nobody tested; D12 overstated `chainId` and the EIP-4361 nonce | accepted: I5, G2 and D12 rewritten; the drainer point kept as the documented fact, not a claim about habits |
| 6 | "Smart-contract accounts cannot sign" is too broad (EIP-7702 accounts recover) | accepted: I6, G4, D16 name ERC-1271 signatures |
| 7 | G1's "every transaction you send is final" contradicts the Terms | accepted, demonstrated: "cannot reverse a transaction you send" |
| 8 | `changed` proves no prior acceptance; the shape check is loose | accepted: neutral re-ask copy; anchored shape check on read and before storing |
| — | Phrase "on your device only" as what the app stores | rejected: the approved policy's own words (P4-02); its next paragraph already says other software in the browser may read the data |

**a2 re-plan, round 2** (resumed): **approve**; all eight fixes verified, nothing lost with a1's cut steps.

**a2 re-plan, final fresh Codex pass** (gpt-6.1-sol, high, new session with the ledger and the contested
points): conditional approve. D12–D17 held; it reran the check in memory (true on the text and its replay,
false for another origin and after a document change).

| # | Finding | Disposition |
|---|---|---|
| 1 | G7 omits that an already-open tab keeps asking for the old version after both deploys succeed | accepted: G7 Detail; still a known limit (detecting a deploy is a new lifecycle) |
| 2 | No gate proves the session fallback when `setItem` throws | accepted: a P8 case, with a remount control |
| 3 | Security still says the record holds "two digests and no personal data" | accepted, demonstrated: corrected |
| 4 | No case for an old signature relabelled with current digests; no check that nothing prompts before the press | accepted: a P7 case and a P8 assertion |

Resumed verification round: **approve** (the a2 re-plan's final verdict).

**a2 code, Codex round 1** (gpt-6.1-sol, high, fresh session, the adversarial prompt): two low findings,
three comment fixes; it confirmed both paths await verification and that replay and the clone reduce to the
accepted limit.

| # | Finding | Disposition |
|---|---|---|
| 1 | The dist rule misses a gate string leaking alone into a shared testnet chunk (reproduced in memory) | demonstrated, fixed: testnet and local refuse the gate testid prefix; mainnet requires it; leak and clean cases |
| 2 | No root test holds the check open to prove neither screen renders meanwhile | fixed: a held check, then `none` and `accepted` controls |
| — | Comments: section labels in the gate, the press-time read's reason, `readAcceptance` called an old version `none` | fixed |

**a2 code, same-family review** (Opus 5.5, beside round 1): five findings; four more were already fixed by
round 1. It checked every G1, G2 and G4 string byte for byte and the layout against the signed mocks.

| # | Finding | Disposition |
|---|---|---|
| 1 | The policy's `updated` stays "29 October 2026", the same as #28's version, so the landing's date cannot tell the two apart | partly: kept, as a1's rule (the final revision's UTC date) gives that date; if the merge lands after 29 October UTC, bump `updated` in `privacy.ts` first (it only re-digests, and the gate asks again). Named in the PR body and the report |
| 2 | viem loads secp256k1 as a lazy chunk; a deploy that replaces it between load and press makes a fresh signature fail with advice to switch accounts | plausible: folded into the version-skew known limit (an open tab across a deploy; a reload fixes it). A static import needs a new direct dependency |
| 3 | The double-press test proves `disabled`, and `sign()`'s pending guard is dead | demonstrated, fixed: guard removed; the test says what it proves |
| 4 | Disabling the focused button sends focus to the body, so a keyboard retry needs Shift+Tab | fixed: focus returns to the button after a failure unless the user moved it; a unit case and a browser check (Enter to refuse, Enter to accept) |
| 5 | `-32002` is EIP-1474, not EIP-1193; a test helper's comment; the dist rule's chunk comment; a redundant catch comment; a test title | fixed |

**a2 code, Codex round 2** (resumed, the fix diff): **no material findings**; it reran its dist-rule
reproducer and checked the held check, the focus return (safe after unmount) and the removed guard. One
optional nit (a test comment it read as narration) kept: it says what the assertion proves. Converged in 2
rounds.

## Post-implementation

The repository has no Post-implementation standard; the steps are here.

**While implementing.** Comments follow the repo rule (invariants and non-obvious reasons; never a plan,
phase or review). Log meaningful attempts in `lessons/phase-N.md`. At each gate run
`agent-worktree status terms-1 "phase N green: <next>"`. After 3 failures on one step, stop and
reassess (5 under `/loop`).

**Per arc, after its last code phase is green:**

1. Codex audit: `run-codex.sh <prompt> <worktree> high read-only gpt-6.1-sol` with the arc diff
   (`git diff main...HEAD`), this plan and its ledger, the arc map ("arc N of 2; a2 adds the gate in
   `MainnetRoot`"), and an adversarial and security ask. Include verbatim: *"Report bugs and small,
   targeted improvements only. Do not propose speculative abstractions, extra configuration surface,
   new layers, or rewrites — the smallest change that fixes each real problem. If code works and is
   clear, leave it alone."* and *"Audit the comments for value per character. Flag any comment that
   narrates what the code visibly does, restates its line, references implementation plans / phases /
   reviews, or spends a paragraph where a sentence works — and flag places where a non-obvious invariant
   or constraint deserves a comment it doesn't have. Comments are permanent context every future reader,
   human or LLM, pays to re-read: they must be few, dense, and exact."* and the two lines on `.env`
   files and `~/.agents/orchy/`.
2. Triage: verify each claim; write its path and label (demonstrated, plausible, unsupported). Fix,
   commit, log, then `resume-codex.sh "" <followup> <codex-dir> high` with the fix diff, until a round
   has no new material finding. A fix that adds persistent state, a lifecycle, a protocol, a recovery
   policy or a public contract is a plan change: stop. Still material after 3 rounds: stop and report.
3. `gh pr create --draft --base main --head <branch> --title "<title>" --body-file <file>`, for both
   arcs; `gh pr ready` only as P6 step 5 and P9 say. Watch checks with bounded foreground polls of
   `gh pr checks <n>`.

**Close-out** (a2's last commits):

1. Merge `origin/main`; read what changed in `implementations-plan/index.md` and `lessons.md`.
2. `## Outcome` after the front matter, without a calendar date (the repo rule): status, what shipped
   with PR numbers, dispositions, `Known limits:`, `Open items:`, and a line retiring the seeds.
3. Promote general lessons to `lessons.md` (F3/F4 on folding; F3 on `TESTIDS`), dedupe, stay under 8 KiB.
4. File open items as issues (dedupe with `gh issue list --state all --search`). A known limit is a
   `known-limit` issue closed as not planned at once. A suspected weakness is a private draft advisory.
5. Delete `STATUS.md`. In its own commit, `git mv implementations-plan/terms-1
   implementations-plan/archive/terms-1`, repair links, add one line to `archive/index.md`. No `index.md` row.

**After the merge:** when `git fetch -q origin main && git cat-file -e
FETCH_HEAD:implementations-plan/archive/terms-1/plan.md` succeeds, run `agent-worktree done terms-1
--merged`; relay a refusal, never force.

## Seeds (draft; finalized after approval)

The a1 seeds are retired (a1 merged as #28; they are in git history). The a2 seed, draft until the owner
signs G1–G4:

```
/goal Phases P7–P9 marked ✓ in implementations-plan/terms-1/plan.md, each backed by its validation gate passing in the transcript; the gate's strings, layout and signed text match OWNER-ASKS.md G1–G4 as signed; the a2 Codex fix loop converged (a resumed round with no new material finding, quoted); the a2 draft PR exists (gh pr view output), opened only after that, with the close-out commits on it; bun run audit:tools and bun run test:all exit 0.
```

```
/loop 15m Drive implementations-plan/terms-1 arc a2 per plan.md. Each firing: read plan.md and lessons/; take the next unchecked phase of P7–P9; run its gate after each edit; commit; after P8 run the Post-implementation loop; never merge, deploy, or mark the PR ready; never build a string or layout OWNER-ASKS.md G1–G4 has not signed; stop and report at the a2 draft PR.
```

Recommended: `/goal` (completion shows in the transcript). Use exactly one per session.

Over the 350-line target: the a2 design, its threat paths and four audit tables (a1's three, a2's) are
evidence the implementer needs; a1's completed steps and drafting outlines were cut to git history.
