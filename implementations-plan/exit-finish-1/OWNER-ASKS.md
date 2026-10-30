# exit-finish-1: owner asks

Each entry: the surface, the options with their copy, a recommendation, and what ships while it is open. The surface
is the exit's Activity card (`BridgeJournalCard`): status badge, the Exit · Prove · Finish · Confirm rail, note,
guidance line, links, and the Finish / Retry button. Pictures: the real card on the testnet dev build with a seeded
journal, light theme, 1280 and 390 px, named `<entry>-<option>-<width>.png` (beside the plan, not committed; the
orchestrator has the folder). Copy for states the code cannot reach yet is set in the page for the picture.

**What ships while these are open**: nothing. Arc a1 waits for E0; arc a2 waits for E1–E4.

## E0. Two outcome changes in arc a1, using only today's cards

The app now reads which transaction actually mined at the finish's nonce.

- **(i) A finish the wallet sped up while the app watched**: today, after about 12 minutes, "The finish transaction
  failed — finish again…", then an error on the new finish. With a1: today's done card, "Arrived", its Finish tx
  link pointing at the sped-up transaction (`e2-a`).
- **(ii) A finish cancelled in the wallet while the app watched**: today it can show "Arrived" although nothing was
  paid (the record is then pruned after 7 days). With a1: today's "The (prior) finish transaction failed — finish
  again from this card. Nothing was lost." (`e3-a`).
- Recommendation: approve both. Ships now: nothing.

## E1. The card when Ethereum has not confirmed the finish after the app's wait

Today the first wait (3 minutes) ends with viem's own text and Retry (`e1-today-3min`), rendered as "Timed out while
waiting for transaction with hash "0x…" to be confirmed.Version: viem@2.57.1. Your funds are not lost — retry from
this card." Retry waits about 12 more minutes, then clears the finish (`e1-today`): "Lost signal", the rail failed at
Finish, "The finish transaction failed — finish again from this card. Nothing was lost." A new finish then reverts
if the first one lands.

- **(a) The existing "Finish sent" card** (`e1-a`): the hash is kept; rail on Confirm; guidance "Finish sent — press
  *Finish* to keep watching it confirm."; button Finish; no new string.
- **(b) As (a), plus a calm note** (`e1-b`), like the deposit card's 30-minute note: "Still confirming on Ethereum.
  Press Finish to keep checking — nothing is sent again, and your funds are safe either way."
- **(c) Error style** (`e1-c`): "Lost signal", rail failed at Confirm, button Retry, "Your finish transaction hasn't
  confirmed yet — press Retry to keep watching it. Nothing was lost."
- Recommendation: (b). It says why the card stopped moving without calling anything a failure.

## E2. The card once a late or sped-up finish is found

- **(a) Today's done card** (`e2-a`): "Arrived", the Finish tx link to the transaction that landed, the toast
  "Released <amount> to Ethereum · View tx".
- **(b) As (a), plus a line** (`e2-b`): "Confirmed after the app stopped waiting."
- Recommendation: (a).

## E3. Ethereum cannot find the finish transaction, and the funds have not moved

The wallet's provider no longer knows the transaction. That can mean it was cancelled or dropped, or only that this
provider has not seen it; nothing the app holds today tells these apart, and a finish that is still alive can land
later. This is a retry policy, not only copy.

- **(a) Keep waiting** (`e1-b` or `e1-a`): the card stays "Finish sent". A really cancelled finish then sits there
  until you discard the record.
- **(b) Forget it and offer a new finish** (`e3-a`): today's "failed — finish again" note. If the first one lands
  after all, the new finish is refused before it is sent (or, when both are in flight, one reverts and its gas is
  lost), and the record ends with an error, as in #100.
- **(c) Ask the user** (`e3-c`): note "Ethereum can't find your finish transaction. If you cancelled it in your
  wallet, press Send again; otherwise press Finish to keep waiting." and a second button, Send again (the
  picture's button is a sketch; its style would follow the card's secondary button). A wrong press can end as in
  (b).
- **(d) Let the app prove it** (`e3-d`): the app stores the finish's sender and nonce with the record (two new
  stored fields, also in backups). It reads, at one Ethereum block, whether that nonce is used and whether this
  withdrawal is paid. Used and unpaid means no transaction can still pay it through that nonce, so the card says:
  "Your finish transaction didn't go through — it was cancelled, replaced or reverted. Finish again from this card.
  Nothing was lost." Otherwise it keeps waiting as (a). Records from before this change keep waiting as (a).
- Recommendation: (d). It is the only option that decides on evidence; it needs your yes because it stores data.

## E4. The finish transaction is gone, and Ethereum shows this withdrawal's message already used

This is a finish sped up while the app was not watching, or one another transaction beat. The app cannot verify
which transaction paid: the Aztec node names the message's position, and the security fix in #81, with your
decision that such a finish stays open, forbids completing on that alone. Marking it done is therefore not offered.

- **Today** (`e4-today`): "The recorded finish transaction doesn't match this withdrawal — not marking it done. Your
  exited funds stay claimable on Ethereum.", forever; on a new finish, the raw revert text.
- **(a) Stay open with an accurate note** (`e4-a`), button Retry: "Ethereum shows this withdrawal's message already
  used, but the app can't verify which transaction finished it — for example one you sped up in your wallet. Check
  your Ethereum wallet; this record stays open."
- **(b) Known limit**: keep today's notes; file it as a closed `known-limit` issue.
- Recommendation: (a). It is true, and it never closes a record on the node's word.
