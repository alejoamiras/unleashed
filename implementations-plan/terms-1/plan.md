---
plan: terms-1
tier: mid
driver: claude-code
claude_model: opus
codex_model: sol
code_review: off
explainer: off
eli5_mode: skipped (orchestrator-owned)
status: draft, awaiting approval (final Codex verdict: approve)
base: main @ fb90e36
budget: "recon: 2 Sonnet explorers; code-review: off; Codex gpt-6.1-sol at high for audits and fix loops, at max for the drafting rounds"
---

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
  4. The gate fails closed: storage that cannot be read shows the gate. An acceptance holds for the rest
     of the session even when storage cannot be written.
- **Good enough.** The record stays in the browser: the operator holds no proof of acceptance (I3).
  English only. No "what changed" view between versions.

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

**Asks.** All in `OWNER-ASKS.md` (A1–A14 facts, C1–C8 choices); the plan never assumes a visible answer.
Facts stay `[[OWNER: An]]` placeholders. a1 is marked ready after A1–A14, C1, C2, C3 and C8; a2
starts after C4–C7.

## Architecture & Implementation

One new directory, `apps/tools/src/legal/`. `App.vue` is the only shell file it edits; nothing under
`src/composables/` changes (sdk-1 rewrites it).

```
App.vue ──(mainnet build only: dynamic import)──▶ legal/MainnetRoot.vue
   └─ every other target: AppShell (unchanged)      ├─ /terms   → LegalPage(TERMS)
                                                     ├─ /privacy → LegalPage(PRIVACY)
                                                     └─ else     → [a2: AcceptanceGate until accepted] → MainnetPlaceholderView
```

```ts
// legal/document.ts (internal)
export type Block =
	| { kind: "p"; text: string }
	| { kind: "list"; items: readonly string[] }
	| { kind: "providers"; rows: readonly ProviderRow[] }
export interface ProviderRow { name: string; origin: string | null; role: string; sees: string; policyUrl: string }
export interface LegalDocument {
	id: "unleashed-terms-of-use" | "unleashed-privacy-policy" // rendered as data-legal-doc; the P2 marker
	title: string
	updated: string
	sections: readonly { heading: string; blocks: readonly Block[] }[]
}
```

| File | Change |
|---|---|
| `src/legal/document.ts` | new: the types |
| `src/legal/terms.ts`, `privacy.ts` | new: the documents as typed data |
| `src/legal/LegalPage.vue` | new: text interpolation only, never `v-html`. Title, update date, an `h2` per section, paragraphs, lists, a providers table (policy links `target="_blank" rel="noopener noreferrer"`), plain `<a href>` links to the other document and to `/`. Styles reuse the placeholder's `--ul-*` tokens |
| `src/legal/MainnetRoot.vue` | new: reads `location.pathname` once (lower-case, one trailing slash stripped, as `useShell.sectionAt`) and picks the page. It imports `MainnetPlaceholderView`, so testnet stops shipping the placeholder |
| `src/legal/testids.ts` | new: `LEGAL_TESTIDS`. Not in the global `TESTIDS`, whose unused keys ship to testnet (F3) |
| `src/App.vue` | edit: `const MAINNET_BUILD = import.meta.env.VITE_TOOLS_TARGET === "mainnet"`; `const MainnetRoot = MAINNET_BUILD ? defineAsyncComponent(() => import("./legal/MainnetRoot.vue")) : null`; render it when set, else `AppShell`. One comment: the test must stay a local literal (F3, F4) |
| `src/lib/network-targets.ts` | edit: one comment on `MAINNET_TARGET`: every origin it reaches is a provider `src/legal/privacy.ts` names, pinned by its test |
| `.claude/skills/bridge-generation/SKILL.md` | edit: one promotion step: a mainnet promotion re-traces the Privacy Policy in the same PR |
| `scripts/legal-dist.ts` + `.test.ts` | new: pure `legalDistProblems(key, files: ReadonlyMap<string, string>): string[]` |
| `scripts/verify-build-target.ts` | edit: read the dist's `.js/.html/.css` files and append `legalDistProblems` |
| `src/legal/acceptance.ts` (a2) | new: digests, `isAccepted(getStorage)`, `recordAcceptance(getStorage)` |
| `src/legal/AcceptanceGate.vue` (a2) | new: the C5 pick |

**Dist rule.** A mainnet dist contains both document ids (from a2, also the gate's testid). A testnet or
local dist contains none of them and no file name starting `MainnetRoot`. One problem line per broken
expectation, naming the matching file.

**Provider pin (P4): an allowlist consistency check.** Origins of every `https:`/`wss:` source in
`MAINNET_TARGET.cspConnectSrc`, plus those of `nodeUrl`, `readRpcUrls`, `acrossApiUrl` and
`webWalletUrls`, must equal the non-null `origin` values in the providers block. Both sets are empty
today. The hosting row is always present. The pin cannot see request contents or wallet-routed calls
(F8); the code trace covers those.

**Version and record (a2).** `version(doc) = sha256(stringToBytes(JSON.stringify(doc)))` (viem), computed
at module load. `localStorage["unleashed:legal-acceptance"] = {"v":1,"terms":"0x…","privacy":"0x…"}`.
`isAccepted` is true only when reading the storage, parsing and the shape all succeed and both digests
match. `getStorage` is `() => window.localStorage`, so a throwing getter counts as "not accepted".
`recordAcceptance` ignores a failed write; `MainnetRoot` holds the acceptance in a `ref` for the session.
Any edit re-asks (C6). Each mainnet host is its own origin, so a user accepts once per host. No test can
force a fresh "Last updated" date (a pin of date and digest passes when only the digest is updated), so
every text edit updates `updated` and the fix loop checks it.

**Trade-offs:** ledger D1–D10.

## Document outlines (the drafting brief for P3 and P4)

**Terms of Use.**

1. Acceptance and eligibility: minimum age (A6), legal capacity, no sanctioned person or place, other
   barred places (A7).
2. What the app is: experimental open-source proof-of-concept software, as is; an interface to contracts
   on Ethereum and Aztec. Wallets, LI.FI, Across and the networks are separate products, even where
   related parties publish them (A14).
3. No custody: the operator never takes custody of keys, funds or claim secrets. The user signs every
   transaction in the user's own wallets. Transactions are recorded on public networks, what is visible
   depends on the kind of transaction (private Aztec sends hide more), and they are final.
4. Pause and owner powers (F9, holders A13): what each pause covers, that claims are never paused, the
   router sweep of stray balances, and that no role can move escrowed funds. No liability for a pause.
   P3 traces each power in the contracts and states only what the trace shows.
5. The user's responsibility: keys, wallets, backups, browser storage (a cleared journal can make a
   claim unrecoverable), addresses, amounts, fees and taxes.
6. Risks the user accepts: contract bugs (audited or not), resets, pauses, delays, third-party failure, a
   lost claim secret, regulatory change, total loss.
7. No advice, no fiduciary duty. Prohibited uses: unlawful use, sanctions evasion, attacks on the app.
8. Apache-2.0 governs the code; these terms govern the hosted interface and restrict no license right.
9. Disclaimer of warranties, in capitals. Limitation of liability: no indirect or consequential loss; a
   total cap (A8). Explicit carve-outs: death or personal injury by negligence, fraud, gross negligence
   or wilful misconduct where the law forbids excluding it, and statutory rights that cannot be waived.
10. Indemnity by the user. A release, with a California Civil Code § 1542 waiver where it applies.
11. Changes: the operator may change, suspend or end the app at any time. A changed document is asked
    again before further use.
12. Governing law, venue and disputes (A4, A5); if arbitration: individual claims, no class, no jury.
13. Severability, entire agreement, no waiver, assignment, contact (A3).

**Privacy Policy.**

1. Who is responsible and how to reach them (A1–A3).
2. In short: what the mainnet app does today. No accounts, no analytics, no cookies from the app, no
   server of ours that receives your data; our host may set security cookies (A9), and while the login
   wall stands Cloudflare checks the login and sets its own cookie (A10).
3. Your browser: each item the app writes, in plain words, including what stays readable (F6), that
   invalid records are set aside and kept, and that completed records go after 7 days; the libraries
   the app uses may cache public data such as proving parameters (F5). Nothing is sent to the operator.
   Clearing it can lose a claim.
4. Hosting: Cloudflare sees each visitor's IP address, browser, page and time; what the operator sees and
   for how long (A9).
5. Your wallets make their own calls, their RPC included; that is the wallet maker's matter.
6. Services the app calls, by kind, traced to code: the Aztec node (IP, tx and message hashes, nullifier
   witnesses), read RPCs (IP, L1 address, source tx hash), the token-list CDN (ordinary request data: IP,
   browser headers, the page origin, the time; no address or transaction), Across (amount, recipient,
   chain ids, message). Then the pinned table of named providers (empty today), and "each
   provider is named here before bridging opens".
7. Public chains: what a send, a claim and an exit publish, permanently; what a private send keeps off
   the chain. A private send is not anonymity.
8. Backups: a file the user keeps; the record is encrypted, the header is not (F7).
9. Links: the site a link opens sees the address or transaction in it.
10. No sale, no ads, no profiling. Legal bases (legitimate interests for hosting), retention, transfers
    abroad, rights and the right to complain to a supervisory authority, kept unless A12 shows the GDPR
    and UK GDPR cannot apply. Minimum age. Changes and re-acceptance. Contact.

## Security & Adversarial Considerations

- **Threat model.** The documents are committed, trusted data. The surface is the renderer (XSS: text
  interpolation only, tested in P1), hidden text (bidi and zero-width characters U+200B–U+200F,
  U+202A–U+202E, U+2066–U+2069, U+FEFF, rejected in P1), the gate's storage, the build split (the P2 rule
  in CI on every target), and the documents' truth (traces, Codex rounds, the P4 pin, the P6 placeholder
  guard, draft PRs until the owner approves).
- **The gate is not access control.** The user owns the browser and can write the record by hand. The gate
  records assent; no code may treat it as a security check. It fails closed (a throwing storage getter or
  read, a malformed record, an old digest) and holds two digests and no personal data.
- **Unchanged:** the CSP, `frame-ancestors 'none'` on every path, and the dependency set (none added).
- **Signature option.** A signature prompt on arrival teaches users to sign what a page asks, which
  phishing exploits; without a server the operator never receives it (C4).

## Phases

UI impact lines quote the recorded owner decisions: none recorded yet. Every visible part waits for the
named entry. Testnet: none, in every phase.

### Arc a1: the documents, rendered on mainnet only

**P1 ✓: mainnet root and renderer.** UI impact: the pages are visible on mainnet; the PR waits for C3.

1. Add `document.ts`, `testids.ts`, `LegalPage.vue`, `MainnetRoot.vue`, and skeleton `terms.ts` and
   `privacy.ts` (title, one section). Edit `App.vue`.
2. Tests: `LegalPage.test.ts` renders each block kind, renders a `<script>` string as text, links the
   other document. `MainnetRoot.test.ts`: `/terms`, `/privacy`, `/Terms/`, and `/` (the placeholder).
   `legal-text.test.ts`: no hidden characters (control: the matcher catches U+202E). Move `App.test.ts`
   to `vi.stubEnv` + `vi.resetModules`: mainnet renders the root and never loads the shell; testnet
   never loads `MainnetRoot`.

Gate: `bun run lint && bun run typecheck:all && bun run --cwd apps/tools test`, exit 0 (lint, typecheck, unit).

**P2 ✓: prove "mainnet only" in the dist.** UI impact: none. Built to D11: the rule checks the placeholder's links and chunk, and the landing's guard checks the pages.

1. Write `scripts/legal-dist.ts`; wire it into `verify-build-target.ts`.
2. `legal-dist.test.ts`: one broken expectation per case (mainnet without each id; testnet with an id;
   local with an id; testnet with a `MainnetRoot` chunk), plus a clean control per target.
3. If testnet still carries the chunk, apply I1's fallbacks in order; log it in `lessons/phase-2.md`.

Gate: the P1 gate, then `bun run --cwd apps/tools build:testnet && bun run --cwd apps/tools verify:build-target testnet && bun run --cwd apps/tools build:mainnet && bun run --cwd apps/tools verify:build-target mainnet`; both print ✓ (adds build).

**P3 ✓: draft the Terms of Use.** UI impact: the text is C1. Closed after three Codex rounds (`lessons/phase-3.md`).

1. Trace each privileged function (F9) and each risk the outline names; record claim → code in
   `lessons/phase-3.md`. Write `terms.ts` from the outline, in plain sentences, each term defined once.
2. Codex rounds: `~/.claude/skills/codex/scripts/run-codex.sh <prompt> <worktree> max read-only gpt-6.1-sol`,
   then `resume-codex.sh "" <followup> <codex-dir> max`. Ask for operator protection within the law,
   enforceability per clause (US, EU, UK), claims the code cannot back, and plain language. Every prompt
   carries the two lines on `.env` files and `~/.agents/orchy/`.
3. Log each round: objections, each accepted or rejected with the reason.
4. Done when a round raises no material objection. A point Codex raises again without new evidence after
   a reasoned rejection is a disagreement, not a new objection: it goes into C1's Detail for the lawyer.

Gate: the P1 gate; the closing round's verdict quoted in `lessons/phase-3.md`.

**P4 ✓: draft the Privacy Policy.** UI impact: the text is C2. Closed after three Codex rounds (`lessons/phase-4.md`).

1. Trace the dist (`.js` chunks), not only `src`, for storage APIs and remote hosts, and resolve each hit
   to its caller; record claim → code in `lessons/phase-4.md`. Write `privacy.ts` from the outline.
2. `privacy.test.ts`: the provider pin (control: a fixture target with one extra `https:` origin fails;
   `data:` and `blob:` are ignored). Add the runbook line and the `MAINNET_TARGET` comment.
3. Codex rounds as in P3; also ask whether each statement matches the code it cites.

Gate: the P1 gate; the closing round's verdict quoted in `lessons/phase-4.md`.

**P5: review, screenshots, draft PR.**

1. The Codex fix loop on the a1 code diff (Post-implementation).
2. Claim a port: `bun apps/tools/scripts/e2e/resolve-ports.ts <state-dir> terms-1-shots $$`; in
   `apps/tools` run `TOOLS_DEV_PORT=<port> bunx vite --config vite.mainnet.config.mts` in its own process
   group.
3. With Playwright (`PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright`), open `/terms` and `/privacy`
   directly and capture both and `/` at 1280 and 390 px, light and dark, into
   `implementations-plan/terms-1/design/` (gitignored). Log what the run checked in `lessons/phase-5.md`.
   Stop the server by its process group; release the port with `--release`.
4. `gh pr create --draft` (Delivery). Name the screenshots in the arc report.

Gate: `bun run audit:tools && bun run test:all && bun run e2e:tools` exit 0 (`App.vue` is the testnet
shell's entry too), and the P2 build commands.

**P6: the owner's answers.** Starts when A1–A14, C1–C3 and C8 are answered.

1. Merge `origin/main`; redo the P3 and P4 traces against it (sdk-1 may have moved the code they cite).
2. Fill every placeholder; apply the C1/C2 edits and C3 (for example two links under the placeholder's
   links, with `App.test.ts` and `MainnetPlaceholderView.test.ts` updated). If C8 is yes, add the landing
   links (`apps/landing/src/content.ts` `LINKS`, its tests, `scripts/dist-checks.ts`).
3. Extend `legal-text.test.ts`: neither document contains `[[OWNER` (control: a sample is caught).
4. Run the P3/P4 drafting rounds again on the filled documents, to the same done rule, and resume the
   code fix loop on the diff until clean. Take fresh screenshots.
5. `gh pr ready` only after the owner approves the final screenshots and text of this revision (the
   orchestrator records it); a later visible change needs that approval again.

Gate: the P5 gate.

### Arc a2: the acceptance gate (after a1 merges and C4–C7 are answered)

**P7: the acceptance record.** UI impact: none.

1. Write `acceptance.ts`. If C6 picks "only important changes", stop: a hand-set version is a plan change
   (D3).
2. Tests: empty storage → false; a recorded acceptance → true; a changed terms or privacy digest → false;
   bad JSON, a wrong shape, `v` ≠ 1, a throwing `getItem` and a throwing storage getter → false; a
   throwing `setItem` does not throw. Control: one changed character changes the digest.

Gate: the P1 gate.

**P8: the gate screen.** UI impact: the whole screen is C4–C7; it is built only to the owner's picks.

1. Build `AcceptanceGate.vue` to C5. If C4 picks the wallet signature, stop: Ethereum wallet code in the
   mainnet root is outside this file map, so it is a plan change.
2. `MainnetRoot` shows the gate on every path except `/terms` and `/privacy` until accepted, then the
   placeholder. Add the gate's testid to the P2 rule.
3. Tests: the gate hides the placeholder; both documents render without acceptance; Continue stays
   disabled until the box is ticked (if C5 has a box); accepting shows the placeholder and writes the
   record; a stale record shows the gate; focus starts on the gate's heading; the keyboard alone
   completes it.

Gate: the P2 gate.

**P9: review, screenshots, PR, close-out.** As P5, plus: in the dev-server run, accept by keyboard, reload,
and confirm the gate stays away; then empty storage and confirm it returns. The PR opens as a draft and
becomes ready only after the owner approves the gate's final screenshots and copy, and, if C7 says "only
when mainnet opens", only once mainnet opens (no activation flag). Then the close-out. Gate: the P5 gate.

**Owner's release step (each arc).** After the merge deploys, open `/terms`, `/privacy` and `/` on both
mainnet hosts in a browser logged in through Access. This is the only check of the production bundle on
its real host (F10).

## Delivery

| Arc | Phases | Branch | Base | PR title | code-review |
|---|---|---|---|---|---|
| a1 | P1–P6 | `worktree-terms-1` (carries the plan commit) | `main` | `feat(tools): add the mainnet terms of use and privacy policy` | off |
| a2 | P7–P9 + close-out | `terms-1-gate`, cut from `main` after a1 merges | `main` | `feat(tools): ask for acceptance of the mainnet terms before use` | off |

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
| D7 | Method | recommend the click-through (C4) | — the owner decides |
| D8 | Browser coverage | jsdom tests + the dist rule as the regression layer; a scripted dev-server run per arc; the owner's post-deploy check | a committed mainnet browser spec: the browser suite builds only `local`, and the production bundle refuses localhost by design (F10), so a spec would need a new target in the harness to test what jsdom already proves |
| D9 | Drafting effort | Codex at `max` until no material objection; a repeated, reasoned-against point is a recorded disagreement | a fixed round cap: the lane brief says rounds run until no material objection |
| D10 | Legal testids | `src/legal/testids.ts` | the global `TESTIDS`: its unused keys ship to testnet (F3) |
| D11 | Where the public reads the documents (C8) | G: a data-only package `packages/legal` (`@unleashed/legal`) holds the documents, their ids and their public URLs; the landing renders static `/terms` and `/privacy` (CSS and theme boot, no script); the mainnet placeholder links there; a2 imports the package for the digests. Codex and Opus both chose G | C: an Access bypass on the app host for `/terms`, `/privacy` and `/assets/*` (a dashboard dependency, and it exposes the walled bundle). H: the documents in the landing until a2 (a move in a2, and a2's gate would import from an app). L: a renderer per app (two renderers of one text) |

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

**Outline B (competing).** Markdown under `docs/legal/`, converted by a mainnet-only vite plugin into
static HTML pages, the gate in one later arc. *For:* Markdown is easier for the owner and a lawyer; pages
need no JavaScript; the config keeps them off testnet. *Against:* a Markdown converter and a plugin to
maintain; a raw-HTML and URL policy for the converter; page styles outside the app's components; and the
gate still needs a digest the plugin would have to emit. A fits the typed-copy convention
(`apps/landing/src/content.ts`), the Vue renderer and the zero-dependency budget.

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

```
/goal Phases P1–P5 marked ✓ in implementations-plan/terms-1/plan.md, each backed by its validation gate passing in the transcript; the Codex drafting rounds for both documents closed per P3/P4 step 4, quoted in lessons/phase-3.md and phase-4.md; the a1 Codex fix loop converged (a resumed round with no new material finding, quoted); the a1 draft PR exists (gh pr view output), opened only after that; bun run audit:tools and bun run test:all exit 0.
```

```
/loop 15m Drive implementations-plan/terms-1 per plan.md. Each firing: read plan.md and lessons/; take the next unchecked phase; run its gate after each edit; commit; at an arc's end run the Post-implementation loop; never merge, deploy, or mark a1 ready; never start P6 or a2 before the owner's answers reach plan.md; stop and report at the a1 draft PR.
```

Recommended: `/goal` (completion shows in the transcript). Use exactly one per session.

Over the 350-line target: the two document outlines (the drafting brief) and the three audit tables
are evidence the implementer needs; restatement was cut.
