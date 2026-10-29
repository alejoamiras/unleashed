# send-copy-2: owner asks

Every entry is testnet only: mainnet copy stays as it is. Until an entry is signed, today's text ships. Values in
braces are the code's variables; the mocks fill them with a 5.00 USDC send from Base Sepolia (fee 25.0 %, cap 8.00
USDC, fill window 2 hours). Each mock shows before and after in the light theme. The mocks live in this folder's
gitignored `design/` (`review.png`, `progress.png`, `card.png`, `activity.png`).

## §0 A send from Base Sepolia whose pause check fails

**Surface.** The cross-chain review, at Sign and send. P9-01 B stops a route the check reads as paused, with
"Deposits on this route are paused right now. Nothing was sent." It does not say what happens when the check itself
fails: Ethereum's read RPC or the Aztec node does not answer, or the deployed contracts do not match this release
(the same answers make the Ethereum send refuse).

**Options.**
- A. Send as today. If the route is in fact paused and the delivery reaches Ethereum, the deposit there fails, the
  delivery goes to the user's Ethereum wallet and the relay fee is spent. If the contracts do not match this release, the deposit may land
  where the current Aztec network cannot claim it. If Ethereum's read RPC is down, the send usually stops a moment
  later with today's error.
- B. Stop with the Ethereum send's sentence: "This app could not check the bridge on this network. Nothing was sent."

Either way, a read that hangs instead of failing keeps Sign and send and Back busy until it returns. The Ethereum
send behaves the same today.

**What ships now.** A.

**Recommendation.** B. The Ethereum send already does this, and a mismatch can strand the money.

## §1 Review (mock: `design/review.png`)

| Id | When it shows | Before | After |
|---|---|---|---|
| R1 | top of every testnet cross-chain review | Testnet: our testnet relayer fills this send on {l1}, usually within a few minutes. | B1 (recommended): remove the notice. The Takes row already says how long. B2: "Testnet: usually a few minutes." |
| R2 | Send row, under the amount | Fixed testnet terms: the relay fee is {fee} of the amount, and one send carries at most {cap} {symbol}. | Fee {fee} of the amount. At most {cap} {symbol} per send. |
| R3 | Takes row | Usually a few minutes for our testnet relayer to fill it on {l1}, a few minutes for Aztec to pick it up, then your claim. | Usually a few minutes, then you claim it on Aztec. |
| R4 | note under the rows | If the deposit can’t run on {l1}, the {symbol} goes to your own address {user} there instead. You can continue from there later; that needs a little test ETH for gas. | If the deposit on {l1} fails, the {symbol} goes to your address {user} there instead. Moving it on from there needs a little test ETH. |
| R5 | Details open, "Quote" row | Fixed testnet terms, rebuilt every 60 s | Valid for 60 s *(the review does not refresh itself; it expires)* |
| R6 | band under the review; on phones, the review's bottom bar | Terms valid for 0:42 · rebuilt before you sign | Valid for 0:42 |
| R7 | in Sign and send's place, after 60 s | These terms expired. / They’re rebuilt from the latest block; nothing was signed. / [Rebuild terms] | This review expired. / Nothing was signed. / [Refresh] |
| W1 | button on a refused or switched-account route (on the review, and on the amount step's refused-route box), and on an expired or unsent card | [Get new terms] | [Try again] |

**What ships now.** Today's text for every row.

## §2 Progress steps (mock: `design/progress.png`)

| Id | When it shows | Before | After |
|---|---|---|---|
| S1 | Bridge step, and the card's line, from the source confirm until it lands on {l1} | {rail} holds your {symbol} until our testnet relayer fills it on {l1}. Nothing for you to do. | Moving your {symbol} to {l1}. Nothing for you to do. |
| S2 | Bridge step's time while it runs (also on the background strip) / as an upcoming step | usually a few minutes, up to 2 hours / up to 2 hours | usually a few minutes / a few min |

S2 is a step estimate, which the gas-floor-1 lane also edits. If you sign it, the orchestrator picks the lane that
ships it; this lane ships it only if gas-floor-1 leaves that line alone.

**What ships now.** Today's text.

## §3 Card (mock: `design/card.png`)

| Id | When it shows | Before | After |
|---|---|---|---|
| C1 | card line of an expired send | It wasn’t filled on {l1} within 2 hours. (No window recorded: "It wasn’t filled on {l1} in time.") | It didn’t reach {l1} in time. |
| C2 title | outcome panel of an expired send | Not filled on {l1} | Didn’t arrive |
| C2 happened | same | This transfer waited 2 hours for our testnet relayer on {l1} and wasn’t filled, so it expired. (No window: "This transfer wasn’t filled on {l1} in time, so it expired.") | It didn’t reach {l1} in time, so it expired. |
| C2 means | same | Nothing reached {l1} or Aztec, and there is nothing to claim. {rail} keeps the {symbol} in its pool on {src}: testnet sends are not refunded automatically. The network fee for the send is not returned. | Nothing reached Aztec, so there is nothing to claim. Testnet sends are not refunded automatically, and the network fee is spent. |
| C2 next | same | Try again with new terms. Or send from another network instead. | Try again, or send from another network. |
| C3 | "What to do next" of an unsent card | Get new terms and sign again. (Open approval: "Revoke the approval, or get new terms and sign again." Reverted: "Get new terms and sign again. Your amount, privacy and gas choice are kept.") | Sign again. ("Revoke the approval, or sign again." / "Sign again. Your amount, privacy and gas choice are kept.") |

The expired card's buttons become [Try again] (W1) and [Pick another balance] (unchanged).

**What ships now.** Today's text.

## §4 Activity row (mock: `design/activity.png`)

No change proposed. No testnet row string names a mechanism today: an expired row reads "Expired" with its
visibility, and every other row word is shared with mainnet.

## §5 An exit's decline from token selection

**Surface.** The exit review. When the wallet declines the token at selection, the review says "Your wallet declined
this token. Sign and send again to retry." No send wrote it: it says the permission is still missing. After P9-02
it is the one notice that survives Back then Next, because it is not a send error. Its "Sign and send again" does
not ask for the permission again today: the exit refuses with "…pick it again to request access. Nothing was sent."
Picking the token again is what asks.

**Options.** A. It stays until the token is picked again (today). B. It clears with the send errors.

**What ships now.** A. **Recommendation.** A: the exit still cannot go until the token is granted.

## Not proposed

- The amount step's "Fixed testnet terms" (`CrossChainFees.vue`) is outside the four surfaces. After R5 to R7 it is
  the one place that still says "terms". Say if it should match.
- Strings both networks share (the route line, "You sign", the session log, "waiting for … to finalize") stay as they
  are, because mainnet copy does not change.
