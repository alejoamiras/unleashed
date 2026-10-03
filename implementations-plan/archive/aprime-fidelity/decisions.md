# Owner decisions

The owner answered six questions on the decision page and delegated the remaining calls.
Owner, verbatim: "basically, my only pick different from your recs was on Q1, I said "A"".
So Q1 is A and Q2–Q6 take the recommendation. The delegated calls stand as listed; none were sent back.

## Owner questions

### Q1 · Theme switch: keep the one cycling button, or show three choices? (OQ1) → **A**

Today the rail foot has one 'System' button that cycles through the themes. Every board draws three visible choices instead, but in three different styles. You told us to keep the cycling button (plan decision D4), so only you can reverse that.

- **A** ← chosen: Keep the single cycling button as it is. [maps to OQ1 A]
- **B** (recommended): A labelled vertical list (Dark / Light / System) as on the Token, Amount and Review boards, with one small icon button on phones. [maps to OQ1 B]
- **C**: Three side-by-side cells, each an icon over a small label, as on the Faucet board. [maps to OQ1 C]
- **D**: Three icon-only cells under a 'Theme · dark' caption, as on the Receipt, In-flight and Activity boards. [maps to OQ1 D]

### Q2 · Token icons: flat brand colours, or keep the striped anti-look-alike tiles? (OQ16) → **A**

Today every token tile has diagonal stripes in a colour computed from its address, so two tokens both called 'USDC' look different. The boards use flat brand colours (USDC blue) and plain grey for unknown tokens. Either way, every row will now also show the token's address (already decided), which is the stronger look-alike defence.

- **A** (recommended) ← chosen: Brand colours only for the real tokens on our list, and a plain grey tile for anything unknown or pasted in, so a fake 'USDC' can never look blue. [maps to OQ16 A (+ OQ17 A)]
- **B**: Keep the striped hashed-colour tiles for every token, with the new row layout. [maps to OQ16 B (+ OQ17 A)]
- **C**: Brand colours for tokens on our list, plus a flat (not striped) colour computed from the address for unknown tokens, so two unknown look-alikes still differ. [maps to OQ16 A for listed tokens + OQ16 B's hashed hue for unknown tokens (combination not in the audit)]

### Q3 · Phones and narrow screens: how should the Activity panel behave? (OQ12, OQ35) → **A**

Today a 44px Activity strip eats the right edge on phones. When a claim needs you, the panel pops open over whatever you're doing, and at tablet width it covers the page without dimming it. The Mobile board has no panel at all: Activity is the third tab with a magenta count. Removing the pop-up means a waiting claim is signalled only by that count.

- **A** (recommended) ← chosen: Follow the board: no panel on phones (the Activity tab's magenta count is the signal), and on tablets the panel opens only when tapped, over a dimmed static background. [maps to OQ12 A + OQ35 A]
- **B**: On phones, drop the strip but let the Activity tab open the panel as a sheet; tablets as in A; nothing pops open by itself. [maps to OQ12 B + OQ35 A]
- **C**: Keep today's behaviour: strip on phones and the panel popping open over the page whenever a claim needs you. [maps to OQ12 status quo + OQ35 C]

### Q4 · Which extra detail rows should the receipt show? (OQ5) → **B**

The Receipt board lists From, Network fee and Visibility. The app shows none of them. Visibility is free. An honest 'From' requires recording the sending address at send time, because using whichever account is connected now could show the wrong one. An Ethereum fee row must not be called 'Network fee', since the review already uses that name for the Aztec fee.

- **A**: Add Visibility only. [maps to OQ5 (subset: Visibility only)]
- **B** (recommended) ← chosen: Add Visibility and From, recording the real sending address at send time; older records simply show no From row. [maps to OQ5 A (sender recorded, not read from the current connection)]
- **C**: Add all three, with the Ethereum cost labelled 'Ethereum fee' so it can't be confused with the Aztec fee. [maps to OQ5 B]
- **D**: Add none. [maps to OQ5 C]

### Q5 · Footer: follow the boards, and where does the mainnet warning go? (OQ24) → **B**

Today every screen ends in a two-line footer: contract links plus a tagline. On mainnet that tagline is the 'Real funds — keep it small' warning. The boards show a one-line footer only on the Token, Amount and Review steps, with no tagline and no footer at all on in-flight, receipt or Activity.

- **A**: Follow the boards exactly, and move the mainnet warning into a chip in the page header. [maps to OQ24 A]
- **B** (recommended) ← chosen: Board footer on the three form steps only; testnet drops the tagline, and mainnet keeps 'Real funds — keep it small' as a second line where it is today. [maps to OQ24 A for testnet + OQ24 B's tagline kept on mainnet]
- **C**: Keep the footer on every screen, restyled to the board's one-line look, with the tagline kept. [maps to OQ24 B (with the board's footer styling)]

### Q6 · How loudly should failed or suspicious transfers show in Activity? (OQ34) → **B**

Today it's backwards: failed records get the amber 'act now' edge, and records waiting for your claim get nothing. The board's rule is that amber means 'you have to act' and red means 'lost signal'. But the board draws no edge on failed cards, so a tampered or mismatched record could look calmer than a routine claim. No failure state was captured, so the pictures are mockups.

- **A**: As drawn: failures get a red 'Lost signal' chip and no edge, claimable records get the amber edge plus 'Needs you', and dead ends show their note with no button. [maps to OQ34 A]
- **B** (recommended) ← chosen: Same as A, plus a red edge on failed cards, so a failure is never quieter than a claim. [maps to OQ34 B]
- **C**: Keep amber on every record that needs attention, failed or not. [maps to OQ34 C]

## Delegated calls

- **OQ2 → A** · Finished transfers say 'Arrived' everywhere. The receipt, dock rows and Activity cards say 'Arrived' instead of Bridged/Released/Fueled. The 'Bridged ✓' stamp, the done edge and the flash go away. The toast keeps its full sentence. _Why:_ All four judges picked A. Every board with a finished state says 'Arrived', including a withdraw row, and the word is true for withdraws and Fuel too.
- **OQ3 → A** · Amounts grouped and padded to 2 decimals, never cut short. '250' becomes '250.00' and '1000' becomes '1,000.00' on the receipt, review, balance line, veil and gas breakdown. Extra digits are never cut or rounded, so 0.005 stays 0.005. _Why:_ All four judges picked A. It matches every board sample and keeps the exact 'review said / you got' comparison.
- **OQ4 → A** · Receipt proof print stays out. Nothing new. The receipt gets the board's layout, but the proof-print tile is left out. _Why:_ Three of four judges picked A. The board's caption, 'Same print in your wallet means same transfer', is false because no wallet draws a matching print. On a real-funds bridge, a graphic that looks like verification but proves nothing is a trap. You can still ask for it at the screenshot review.
- **OQ6 → A** · Receipt at the screen board's scale. The receipt gets a 56px pixel hero, a 24px 'Arrived' check, 48px 'New send' and 'Add to wallet' buttons with icons, and the scanline. Long 18-decimal amounts still shrink to fit. _Why:_ All four judges picked A. DCQReceipt is the screen board. The Components sheet is only a specimen.
- **OQ7 → A** · Gas row keeps 'Private FJ', gains '≈ · N transactions'. The Gas ready row reads '≈ 0.84 Private FJ · 2 transactions', and the unused 'Gas used' row goes away. _Why:_ All four judges picked A. 'Private FJ' is the app-wide name for private Fee Juice, and plain 'FJ' would misname what the user holds. The code never fills the 'Gas used' row.
- **OQ8 → A** · Activity cards get status chips; account chip only for another account. Cards gain icon-and-word chips (Private/Public, + gas, Needs you/Proving/Arrived). The account chip appears only when the record belongs to another account ('Other account · savings'). The full address stays on hover, and the testid stays on that chip. _Why:_ Three of four judges picked A. This is exactly what the Activity board draws, and it makes the risky case (funds claimable only from another account) stand out instead of repeating on every card. The scope judge's worry about the testid is answered: tl-journal-account remains on the chip wherever it renders, and only the unit and e2e expectations change.
- **OQ9 → A** · Dock lists the running send as a read-only 'this send' row. While a send runs, the open dock shows it under 'Running' as '250.00 USDC · ETH → Aztec · this send'. The row has no buttons and never opens the dock by itself. _Why:_ Three of four judges picked A. Today the dock says '0 records' while 250 USDC is in flight, which looks broken. The row has no actions, so the stepper stays the only place to act on the record, and the one-surface rule keeps its purpose.
- **OQ10 → A** · Magenta count chip beside Activity in the rail. The needs-you count beside 'Activity' becomes a magenta chip, as on every board, including the phone tab. _Why:_ All four judges picked A. The count is a call to action, and 'a count, not a call' was a code comment, not your decision.
- **OQ11 → A** · Collapsed dock strip: transparent with corner badge. The closed dock becomes the transparent 44×72 strip with a small corner badge drawn on Token/Amount/Review. The open dock keeps 'Hide'. _Why:_ All four judges picked A. It is the variant on the three main-flow boards.
- **OQ13 → A** · Phones keep the × on the Ethereum chip. On phones the wallet chips become full-width one-line rows, as on the Mobile board, but Ethereum keeps its × instead of a chevron menu. _Why:_ Three of four judges picked A. The chevron would need a new Ethereum account menu that does not exist, and the desktop boards keep the ×.
- **OQ14 → B** · Phone amount step: board look, Back and gas breakdown kept. On phones: a visible 'What arrives' heading, one-line choice rows, the balance beside the Amount label and a full-width Continue. Back is stacked under Continue, and the gas breakdown opens from the row hint. _Why:_ All four judges picked B. Following the Mobile board exactly would delete Back and the gas-cost breakdown on phones, which removes behaviour and hides how much of the token goes to gas.
- **OQ15 → A** · 'What arrives' still defaults to Token. Nothing. The boards show a mid-flow frame with 'Token + gas' already picked, not a default. _Why:_ All four judges picked A. A 'Token + gas' default would quietly spend part of the user's amount on gas.
- **OQ17 → A** · Token rows: BridgeToken layout, address on every row, long trim. Each row shows symbol and name on one line, then the address on every token (manifest ones too), with 60px rows and a bare balance. The address keeps the longer 8…6 trim. _Why:_ All four judges picked A. It follows the screen board and adds spoof resistance, because every row now shows its address. This holds whichever tile style you choose in Q2.
- **OQ18 → A** · List balances stay at 2 decimals. Nothing. List-row balances stay at 2 decimals. The amount step still shows the full balance. _Why:_ Three of four judges picked A. Only one board sample (WETH '0.4200') suggests per-token places. Known wrinkle: a tiny balance reads 0.00 in the list but in full on the amount step, as it does today. Flag it at review if that bothers you.
- **OQ19 → A** · Wallet picker: generic wallet glyph and readable type chip. A wallet with no usable icon gets a plain pixel wallet glyph on a grey tile instead of an empty box. The type shows as 'Extension' or 'Web app' in a chip. Unknown types pass through as sent. _Why:_ All four judges picked A. A generic glyph cannot pass for any real wallet's mark, so the 'never a stand-in' safety intent holds. Icon sanitising stays.
- **OQ20 → A** · Same-name wallet warning: board styling, today's safer words. The warning gets the board's amber strip and diamond icon, but keeps the caveat that names are self-reported and the emoji check is what matters. _Why:_ All four judges picked A. The board's 'pick the one you installed' is wrong for web wallets and drops the one warning that matters when two wallets claim the same name.
- **OQ21 → A** · Connect Aztec is the one magenta button. When nothing is connected, 'Connect Aztec' stays magenta with a wallet icon and 'Connect Ethereum' becomes the raised secondary button. _Why:_ All four judges picked A. The board rule is one primary per view, and the wallet modal board draws Connect Aztec as that primary.
- **OQ22 → A** · Deposit signing keeps today's flow (deferred). Nothing now. Signing still moves to the permit stepper. Keeping the user on the review screen while the wallet prompt is open is left to a later arc. _Why:_ Three of four judges picked A. It is a large change to the state machine that moves funds, not a visual fix.
- **OQ23 → A** · Review 'Details': board hint, full portal address kept. The collapsed Details row gets the board's left chevron and right-hand hint, reworded without 'portal'. Inside, the full portal address and its verified/mismatch states stay. _Why:_ All four judges picked A. Replacing the checkable address with 'Derived and checked' would ask users to trust instead of verify.
- **OQ25 → A** · Faucet: board layout with an honest proving panel. Balances become stacked rows (public first, eye icons), drip buttons stack full-width, and the intro says 'test tokens'. The proving panel shows an elapsed timer, a moving bar that claims no percentage, and a neutral log line. One drip at a time, with the reason shown. _Why:_ All four judges picked A. The app cannot see proof progress or where the proof runs, so a fake percentage or an 'on this device' claim would be untrue.
- **OQ26 → A** · In-flight: phase bar, elapsed-only caption, this-session log. The send screen gains the 18px overall bar, the 'phase n of N' caption with elapsed time, and a Log panel built from this session's events and tx hashes. 'About 3 min left' is not shown. _Why:_ All four judges picked A. There is no ETA model to back a 'minutes left' figure, and a stored event log is new data for a later arc.
- **OQ27 → A** · In-flight: locked direction row added, Authorize step kept. A greyed direction switch with 'Direction is locked while this send runs' appears above the send. The phase list still includes Authorize. _Why:_ All four judges picked A. Authorize is a real separate signature, and hiding it would misstate what the user signs.
- **OQ28 → A** · Activity cards: board layout, existing controls kept. Attention-first order, the board's card layout and actions row, and the board's empty row in the dock. Clear, Backup, in-flight explorer links and phase marks stay. A record owned by another account no longer counts as 'needs you'. _Why:_ All four judges picked A. Following the board exactly would delete Clear (the only way to remove a record) and Backup (the only export). Flag at review: the needs-you count drops other-account records.
- **OQ29 → B** · Number 'decode' animation stays deferred. Nothing now. The scramble-to-value animation gets its own later arc. _Why:_ All four judges picked B. Motion does not show in screenshots, and scrambling the figures a user checks needs careful design.
- **OQ30 → A** · Accessibility: only the 'What arrives' cards change role. No visible change. Screen readers hear the three choice cards as radio buttons. Other controls keep their arrow-key behaviour. _Why:_ All four judges picked A. This is invisible plumbing and fixes the one clear semantic error.
- **OQ31 → A** · 'Testnet' chip turns amber, no icon. The Testnet chip changes from lilac to amber, which frees lilac to mean only 'Other account'. _Why:_ All four judges picked A. This is what BridgeToken and Components draw.
- **OQ32 → A** · BridgeAmount is the amount screen; light theme is colours only. Both themes share BridgeAmount's structure. The light board supplies only the palette, and the empty field still shows '0'. _Why:_ All four judges picked A. Separate layouts per theme would be a maintenance trap.
- **OQ33 → A** · Small copy and accessibility calls follow standing rules. One-line subtitle and a hidden step heading. The no-wallet error stays wallet-neutral, and the accessible #65636e grey is kept. The private copy stays truthful. The withdraw line says 'You can leave this page' only while waiting. The account menu uses reverse video, and dialogs get the board's × shell, with × meaning cancel. _Why:_ All four judges picked A. Each item either follows a board or keeps a standing rule: works with any wallet, contrast ≥4.5, honest copy.

## Scope

Arcs 1–9 now; arc 10 (event log, proof print, sign-on-review, decode motion, tooltip primitive, skeleton) stays deferred. Arcs 1–9 are visual and layout work; each owner answer only changes details inside one arc (theme control arc 3, token tiles arc 2, phone dock arc 9, receipt rows arc 5, footer arc 7, failure chips arc 4). The one new stored field, the sender for Q4 option B, sits in arc 5.
