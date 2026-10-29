# terms-1: questions for the owner

The documents are drafts, not legal advice. A lawyer should read them before launch.

Each entry: the question, the options, a recommendation, and what ships while it is open. The owner
reads down to each entry's **Detail** heading; what follows it is for the orchestrator.

## Facts only you can give (they fill the blanks in both documents)

### A1. Who runs the app: you personally, or a company?
- Options: me, by name · a company
- Recommendation: a company, because it keeps your own money apart from claims against the app.
- Ships now: the drafts keep a blank; the documents PR does not merge.

**Detail.** The operator is the contracting party in the Terms and the "controller" in the Privacy Policy.
An individual operator is personally liable for anything the caps do not hold back.

### A2. What name and postal address should the documents show?
- Options: (your answer)
- Recommendation: the company's registered name and address.
- Ships now: a blank; no merge.

**Detail.** GDPR Art. 13(1)(a) needs the controller's identity and contact details when it applies.

### A3. Which email should people use about the terms and their data?
- Options: a new address just for this · an address you already use
- Recommendation: a new address just for this, so legal mail does not mix with other mail.
- Ships now: a blank; no merge.

### A4. Which country's law should govern the terms?
- Options: (your answer)
- Recommendation: the country where the operator is based, because its courts apply it most predictably.
- Ships now: a blank; no merge.

**Detail.** A consumer in the EU or the UK keeps the protections of their home law whatever the choice
(Rome I Art. 6). The choice of law does not decide whether the GDPR applies: A12 does.

### A5. Where should a dispute be settled?
- Options: the courts of a city you name · private arbitration, one person at a time
- Recommendation: private arbitration, one person at a time, where your chosen law allows it; otherwise
  your home courts.
- Ships now: a blank; no merge.

**Detail.** Individual arbitration with a class-action and jury waiver is the most protective form in the
US. EU consumer law often refuses pre-dispute arbitration for consumers (Directive 93/13/EEC, annex 1(q)).
Name the rules and the seat (for example JAMS or ICC, and a city).

### A6. What is the youngest age allowed to use the app?
- Options: 18 · 21
- Recommendation: 18, the usual age to sign a contract.
- Ships now: a blank; no merge.

### A7. Which places should the terms forbid using the app from?
- Options: only countries under sanctions · sanctioned countries plus a list you name
- Recommendation: sanctioned countries plus any your lawyer names. The terms forbid it; the app does not
  block anyone.
- Ships now: the drafts name sanctioned countries and persons and leave a blank for the rest.

**Detail.** Blocking by location would be a product change and is out of scope. The clause is a user
promise (no sanctioned person, no sanctioned place), which is the usual pattern for open-source front ends.

### A8. What is the most the operator should ever owe one user?
- Options: USD 100 · nothing beyond what the law requires · another amount
- Recommendation: USD 100, and let your lawyer confirm it. In some places a court is more likely to
  accept a small fixed sum than zero.
- Ships now: a blank; no merge.

**Detail.** Users pay the operator nothing, so the common "fees paid in the last 12 months" cap would be
zero. Courts are more likely to strike a zero cap as unconscionable.

### A9. Which Cloudflare features are on for the app's two addresses, and what do they show you about visitors?
- Options: only Cloudflare's defaults · a list (logs, analytics, bot or security checks, anything that
  sets cookies or adds scripts) with who sees them and how long they are kept
- Recommendation: keep only the defaults, and tell us what the dashboard shows you about visitors.
- Ships now: a blank in the hosting section; no merge.

**Detail.** The repo's Worker configs turn on no logging (`apps/tools/wrangler.mainnet.jsonc` has no
`observability` key), but zone and account settings live in the dashboard, where the repo cannot see them. "Defaults" alone does
not tell us what the operator can see or how long Cloudflare keeps it. Features to check: Workers Logs,
Logpush, Web Analytics (and its auto-inject), Bot Fight Mode (`__cf_bm` cookie), JavaScript detections
(`/cdn-cgi/challenge-platform/`, which the app's `script-src 'self'` allows), Zaraz, and the sampled
request data the default dashboards show. The policy then says "the app sets no cookies; our host may
set security cookies" and names what applies.

### A10. Will the Cloudflare login wall still be in front of the app when mainnet opens to everyone?
- Options: no, it comes down at launch · yes, it stays
- Recommendation: it comes down at launch.
- Ships now: the policy says that while the wall is up, Cloudflare checks each visitor's login and sets
  its own login cookie. That sentence leaves only in the update that follows the wall coming down.

**Detail.** Cloudflare Access sets a `CF_Authorization` cookie on the protected host. An answer that the
wall *will* come down does not make the policy true while it is still up.

### A11. When should the documents take effect?
- Options: the day they go live · a date you name
- Recommendation: the day they go live.
- Ships now: a blank; no merge.

### A12. Where is the operator based, and is the app meant for people in the EU or the UK?
- Options: based in the EU or UK · based elsewhere, open to EU and UK users · based elsewhere, EU and UK
  users barred
- Recommendation: answer this with your lawyer. If the GDPR applies, the policy gains its required
  sections.
- Ships now: the drafts include those sections, marked to remove if they do not apply.

**Detail.** GDPR Art. 3: establishment in the EU, or offering services to people in the EU (EDPB
Guidelines 3/2018). The UK GDPR follows the same test. Where it applies, the policy must give purposes and
legal bases, retention, transfers abroad and the right to complain to a supervisory authority (Art. 13).

### A13. Who holds the keys that can pause the bridge?
- Options: the operator alone · a group that must agree (a multisig) · someone else
- Recommendation: a group that must agree, because then one lost or stolen key cannot pause the bridge
  alone.
- Ships now: the terms describe each pause power with a blank for who holds it.

**Detail.** Three roles exist in the contracts: the factory owner can pause L1 deposits and withdrawals
(`PortalFactory.sol:62`), the hub guardian can pause exits but never claims (`token_bridge_hub` `main.nr`),
and the router owner can sweep tokens the router holds outside a transaction (`DepositRouter.sol:191`).
None can take escrowed funds. The C5 copy says "never takes custody", not "never holds", because the
portals do hold deposited tokens in escrow.

### A14. Are you or your company connected to the Nulo wallet, Aztec Labs or the Aztec Foundation?
- Options: no · yes (say which and how)
- Recommendation: (a fact, no recommendation) the terms must not call a related product independent.
- Ships now: the terms say the wallets and networks are separate products, "even where related parties
  publish them".

**Detail.** The holding page links to the Nulo wallet, and the login wall admits Aztec Foundation and Labs
identities. If the operator publishes Nulo, a clause saying the operator does not operate the wallets is
false.

## Choices

### C1. Do you approve the text of the Terms of Use?
- Options: approve · approve with edits · a lawyer reviews it first
- Recommendation: a lawyer reviews it first, because the draft is not legal advice.
- Ships now: the documents PR opens as a draft with the text and screenshots, and waits.

**Detail: what each clause does for you, one line each.**
1. Who may use it: keeps out minors and sanctioned users, so you are not serving them.
2. What it is: says it is an experiment given as is, so nobody can claim you promised a product.
3. No custody: says you never take custody of anyone's keys or funds. Whether a court treats you as a
   custodian still depends on the facts.
4. Pause powers: tells users who can pause deposits and exits (never claims), so a pause is disclosed
   and not a broken promise (A13).
5. The user's job: makes keys, backups, addresses and taxes the user's responsibility, not yours.
6. Risks: the user accepts that bugs, network resets, pauses and total loss can happen.
7. No advice, no misuse: you give no financial advice; illegal use is forbidden.
8. Open-source license: the code license stays as it is; the terms cover only the website.
9. No warranty and a liability cap: you promise nothing about the app working, owe nothing for indirect
   loss and at most the A8 amount in total, except what the law never lets anyone exclude (such as
   fraud or injury).
10. Indemnity and release: the user pays your costs if their misuse gets you sued, and gives up claims
    they do not yet know about, where the law allows.
11. Changes: you may change or shut the app at any time; changed terms are asked again.
12. Disputes: where and how a dispute is settled (A4, A5).
13. Housekeeping: aims to keep the rest in force if one clause fails.

### C2. Do you approve the text of the Privacy Policy?
- Options: approve · approve with edits · a lawyer reviews it first
- Recommendation: a lawyer reviews it first.
- Ships now: the documents PR waits.

**Detail: what each section says, one line each.**
1. Who is responsible and how to reach them (A1–A3).
2. In short: what the mainnet app does today; no accounts, no analytics, no cookies from the app, no
   server of yours that gets user data. Your host may set security cookies (A9), and while the login
   wall is up Cloudflare sets its own login cookie (A10).
3. The browser: lists what the app keeps on the user's device, including what stays readable there, and
   that clearing it can lose a claim.
4. Hosting: Cloudflare sees each visitor's IP address, browser and page (A9).
5. Wallets: the user's wallets make their own calls; that is the wallet maker's matter.
6. Services the app calls: what the Aztec node, the chain-reading services, the token-list service and
   the bridge-quote service each see; today the mainnet app calls none of them, and a test keeps the
   named list true.
7. Blockchains: what every send, claim and exit makes public forever.
8. Backups: the file stays with the user; its contents are encrypted, its label is not; you never
   receive it.
9. Links: an explorer the user clicks sees the address or transaction in the link.
10. No selling, no ads; privacy rights where they apply (A12); minimum age; changes; contact.

### C3. Where should the two documents appear?
- Options: (a) their own pages, linked under the three links on the "being upgraded" page · (b) their own
  pages, not linked until the agree screen ships
- Recommendation: (a), so your team can read them now behind the login wall.
- Looks like: (a) the "being upgraded" page gains a second row in the same small type: "Terms of Use ·
  Privacy Policy". Both pages: the document title, "Last updated …", numbered headings, body text at
  most 760 px wide in the app's colours, and at the top "← Back · Terms of Use · Privacy Policy".
  (b) the same pages, reached only by typing `/terms` or `/privacy`.
- Ships now: the PR builds (b). (a) is added once you choose it.

### C4. How should a person agree before using the mainnet app?
- Options: tick a box and press Continue · sign a message with their Ethereum wallet
- Recommendation: tick a box and press Continue. It works before any wallet is connected.
- Either way you keep no proof that a given person agreed: the record stays in that person's browser.
  Keeping proof would need a server that stores personal data, which is a separate decision.
- Ships now: nothing; the agree screen is not started.

**Detail.** Clickwrap with an unticked box, conspicuous links and an active click is the form US courts
enforce most often (*Meyer v. Uber*, 2d Cir. 2017; *Berman v. Freedom Financial*, 9th Cir. 2022). A
signature stored only in the browser proves nothing to the operator. Neither option leaves the operator
any proof that a given person agreed: the record lives in that person's browser. Keeping proof needs a
server that stores it: new storage and personal data, a separate decision outside this lane. A signature request on
arrival also trains users to sign whatever a page asks, which phishing sites exploit.

### C5. What should the agree screen look like?
- Options: (a) a full page before the app · (b) a box over the dimmed app
- Recommendation: (a), because nothing behind it can be clicked by mistake and it reads well on a phone.
- Looks like (both use this copy, to be approved):
  - Heading: "Before you use Unleashed"
  - Body: "Unleashed is experimental software. Its operator never takes custody of your funds or keys,
    and every transaction you send is final."
  - Box, unticked: "I have read and agree to the Terms of Use, and I have read the Privacy Policy."
    Both names are links that open the document in a new tab.
  - Button "Continue", disabled until the box is ticked.
  - (a) fills the page in the app's colours, centred, at most 560 px wide. (b) is the same content in the
    app's dialog box, with no close button, over the page dimmed behind it.
- Ships now: nothing.

### C6. When should people be asked to agree again?
- Options: after any change to either document · only when you mark a change as important (this needs a
  change to the plan)
- Recommendation: after any change. It happens by itself, so nobody can forget to ask.
- Ships now: nothing.

### C7. Should the agree screen go live now, in front of the "being upgraded" page?
- Options: now · only when mainnet opens to the public
- Recommendation: now. Only your team sees it behind the login wall, and it is tested and ready on
  launch day.
- Ships now: nothing. If you pick "later", the finished gate waits as an unmerged draft until mainnet
  opens.

### C8. Should the landing site (unleashed.systems) link to the two documents?
- Options: not until mainnet opens · now, in its footer
- Recommendation: not until mainnet opens. The landing links only to testnet today.
- Ships now: no landing change.
