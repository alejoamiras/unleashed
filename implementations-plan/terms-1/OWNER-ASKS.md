# terms-1: questions for the owner

The documents are drafts, not legal advice. A lawyer should read them before launch.

Each entry: the question, the options, a recommendation, and what ships while it is open. The owner
reads down to each entry's **Detail** heading; what follows it is for the orchestrator.

## Answered

Decision page 1 (P1-01 to P1-17) and decision page 4 (P4-01 to P4-03) answered A1–A14, C1–C4 and C6–C8;
the answers are in the published documents (#28) and in `plan.md`. C4 is P1-14 Option B, "Sign a message
with their wallet", with the note "We will need UX / UI decision page on how it looks." C6 is P1-15
Option A, C7 is P1-16 Option A. C5 (the screen's layout) was never asked; G1 asks it.

## Open: the signed agree screen

You chose that a person signs a message with their wallet before using the mainnet app (P1-14), that any
change to either document asks again (P1-15), and that the screen goes live now, behind the login wall
(P1-16). Nothing is built until you sign G1–G4. G5–G7 have a "ships now" answer and do not hold it.

How it works: the first time someone opens the mainnet app, they see one page. They press "Sign with your
wallet". Their wallet may first ask to connect to the site, then shows a short message. Signing is free and
moves nothing. The app checks the signature and keeps it in that browser, so the next visit opens straight
to the app. When either document changes, the page comes back once and asks again.

The pictures are mocks of the screen in the app's light theme, at 1280 px (a laptop) and 390 px (a phone),
in `implementations-plan/terms-1/design/` (not committed): `gate-<state>-<width>.png`.

### G1. Do you approve the agree screen?

- Options: approve as shown · approve with edits to the words · the same words in a box over the dimmed
  holding page instead of a full page
- Recommendation: approve as shown. A full page leaves nothing behind it to press by mistake, and it reads
  well on a phone. Line 2 matches the Terms, which say you cannot reverse, cancel or speed up a transaction.
- Ships now: nothing; the screen is not built.
- Pictures: `gate-ask-1280.png`, `gate-ask-390.png` (first visit); `gate-reask-1280.png`,
  `gate-reask-390.png` (after a change).

First visit, top to bottom:

1. Heading: "Before you use Unleashed"
2. "Unleashed is experimental software. Its operator never takes custody of your funds or keys, and cannot
   reverse a transaction you send."
3. "To continue, sign a message with your Ethereum wallet. It says you agree to the Terms of Use and have
   read the Privacy Policy. Signing is free and sends no transaction."
4. Two links, each opening the document on unleashed.systems in a new tab: "Terms of Use" and "Privacy
   Policy", each followed by "updated 29 October 2026" (the document's own date).
5. Button: "Sign with your wallet"
6. Under the button, small: "Your wallet may ask you to connect to this site first."

After a change to either document, the same page with a new heading and paragraph, and without line 2:

1. Heading: "The Terms or the Privacy Policy changed"
2. "One or both have a new version. Read them, then sign to keep using Unleashed."
3. Lines 4 to 6 as above, with the new dates.

### G2. Do you approve the message the wallet shows?

- Options: approve as shown · approve with edits to the words
- Recommendation: approve as shown.
- Ships now: nothing.
- Pictures: `gate-wallet-1280.png` (a wallet window over the screen), `gate-wallet-390.png` (a phone
  wallet's sheet). The wallet is drawn plain on purpose: each wallet has its own look. The app asks the
  wallet to show this exact text; most wallets also show the site asking and the account, and some shorten
  the text or add their own warnings.

The text, exactly (the dates, versions, site and account fill in):

```
Unleashed: accept the Terms of Use

I agree to the Unleashed Terms of Use, and I have read the Privacy Policy.

Terms of Use, updated 29 October 2026
https://unleashed.systems/terms
Version 0x<64 characters>

Privacy Policy, updated 29 October 2026
https://unleashed.systems/privacy
Version 0x<64 characters>

Site: https://app.unleashed.systems
Account: 0x<the account's address>

Signing is free. It is not a transaction and moves no funds.
```

**Detail.** Each "Version" is a fingerprint (SHA-256) of that document's exact text: one changed letter
changes it, and anyone can recompute it from the published repository, so the signature names the exact
words agreed to. "Site" is the address the page says it is; the wallet itself shows the address that
really asks, so a copy of the site that asks for this exact text is visible as a copy in the wallet. The
text is plain ASCII, so wallets that show only plain characters can show it. The alternative, a structured
"typed data" request, was rejected: wallets do not check its site field either, and it is the kind of
request wallet-draining sites use, which this screen should not make routine. Full reasoning:
`plan.md` § Arc a2 design.

### G3. Do you approve this edit to the Privacy Policy?

- Options: approve · approve with edits
- Recommendation: approve. Today the policy says the holding page stores nothing in the browser; once the
  screen is live it stores the signature, so the policy must say so.
- Ships now: nothing. The screen waits for this edit: without it, the policy would be false the day the
  screen goes live.
- The edit publishes on unleashed.systems/privacy when it merges, with that day's date.

"What stays in your browser", first paragraph. Now: "The unleashed.systems website stores nothing in your
browser, and neither does the app's holding page. Once the app offers the gas flow, it may store these items
in your browser's local storage, on your device only:" New: "The unleashed.systems website stores nothing in
your browser. The app keeps what it needs in your browser's local storage, on your device only. Today its
holding page keeps one item, your acceptance of these documents. Once the app offers the gas flow, it may
keep all of these:"

Same section, last list item. Now: "Your acceptance of these documents, once the app asks for it." New:
"Your acceptance of these documents: the Ethereum address that signed it, the signature, and the versions
you accepted."

"Your wallets", a new second sentence: "Before you use the app, it asks your Ethereum wallet for your
address and for a signature on its acceptance message."

### G4. Do you approve what people see when signing does not work?

- Options: approve as shown · approve with edits to the words · let smart-contract accounts in too (a plan
  change: see Detail)
- Recommendation: approve as shown.
- Ships now: nothing.
- Pictures: `gate-refused-*.png`, `gate-busy-*.png`, `gate-nowallet-*.png`, `gate-failed-*.png`; the
  waiting line shows behind the wallet in `gate-wallet-*.png`.

Each line appears under the button, which stays on the page so the person can try again:

1. While the wallet is open, the button reads "Waiting for your wallet…" and cannot be pressed, and the line
   says: "Check your wallet and read the message, then sign or cancel. If no window opened, open your wallet
   from the browser's toolbar."
2. The person pressed Cancel in the wallet: "You did not sign. Unleashed stays closed until you accept the
   Terms. You can sign whenever you are ready."
3. The wallet already holds an earlier request from this page (a reload does not clear it): "Your wallet
   already has a request from this page waiting. Open your wallet, sign or cancel it, then try again."
4. No Ethereum wallet in the browser: "No Ethereum wallet found in this browser. Install one, such as Rabby
   or MetaMask, then reload this page."
5. Anything else went wrong: "Your wallet could not sign this message, or sent back a signature this page
   cannot check. Try again, or use another account. Some smart-contract accounts cannot sign here yet."

**Detail.** Some smart-contract accounts (a Safe, for example) sign in a way (ERC-1271) that can only be
checked by asking the blockchain. Accounts that sign with their own key pass, including upgraded ones
(EIP-7702). The mainnet app has no connection to read the chain. Letting the others in is a plan change:
either a chain connection for the mainnet app, which the Privacy Policy would have to name, or accepting
signatures nobody checked.

### G5. Should you keep a copy of each signature?

- Options: no, it stays in the person's browser · yes, on a server you run
- Recommendation: no, for now.
- Ships now: no copy; the signature stays in the person's browser.

**Detail.** Like the tick-box, a signature kept only in the browser gives you nothing to show later: you
never receive it. It does prove, to anyone who has that browser's record, which account agreed to which
exact text. Keeping a copy needs a server that stores wallet addresses next to IP addresses, which is
personal data, and the Privacy Policy, which says no server of yours receives data, would change. That is a
separate plan.

### G6. One acceptance per browser, not per account: is that right for now?

- Options: per browser, as described · ask again when a different account connects (decided in the plan
  that opens the gas flow)
- Recommendation: per browser now; decide the second option when the gas flow opens.
- Ships now: one signature per browser and per site address (app.unleashed.systems and the second address
  that serves the same app each ask once).

**Detail.** The holding page connects no wallet after the signature, so the app cannot yet tell which
account a person later uses. Someone who signed with one account and later deposits from another would not
be asked again. Checking that belongs in the gas flow, which will connect the wallet anyway.

### G7. Can a person sign a version they cannot read yet? Is that acceptable for now?

- Options: accept it for now · show the documents inside the app as well (a plan change)
- Recommendation: accept it for now. Only your team sees the screen until mainnet opens.
- Ships now: the limit, plus a release step: after each merge, check that unleashed.systems and the app
  both serve the merged version.

**Detail.** People read the documents on unleashed.systems, but they sign the versions built into the app.
The two sites deploy separately from the same change, in either order. Between the two deploys, or longer
if one deploy fails, the app can ask for a signature on a version the site does not show yet. A tab
opened before a change keeps asking for the older version until it is reloaded, even after both sites
have the new one. The message
names each document's date, but two edits on one day share a date. Showing the text inside the app would
close the gap, but it adds a second copy of the pages and new screens.
