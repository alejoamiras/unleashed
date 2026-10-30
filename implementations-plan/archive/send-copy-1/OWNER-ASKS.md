# send-copy-1: owner asks

## §1 Should a send from Base (or Base Sepolia) also check the pause first?

**Surface.** A send that starts on another chain (Base Sepolia on testnet; Base, Arbitrum or OP on mainnet), on a
route the operator has paused. P7-01 names the Ethereum send, where "the wallet still prompts twice" and then
nothing moves. A cross-chain send behaves differently today: it is sent, the rail delivers it on Ethereum, the
deposit into Aztec is refused there, and LI.FI hands the token to the user's own Ethereum wallet. The card then
says "Delivered to your Ethereum wallet instead". The relay fee is spent.

**Options.**

- A. Leave it as it is. The money is safe and arrives in the user's Ethereum wallet, minus the relay fee.
- B. Check the pause before the first prompt on the source chain too, with P7-01's sentence: "Deposits on this
  route are paused right now. Nothing was sent." The send never leaves the source chain, and no fee is spent.

**What ships now.** A: nothing changes for a cross-chain send. The Ethereum send gets P7-01 in this arc.

**Recommendation.** B, in a later arc. It spares the relay fee and a detour through Ethereum, and it reuses the same
check. It is a new refusal on the cross-chain path, so it is your call.

## §2 Should a refusal's sentence clear when the review is re-entered?

**Surface.** The Ethereum send's review after P7-01 or P7-02 refuses. If the user goes Back and then Next, the new
review still shows "…Nothing was sent." before they have pressed anything. Every send error on this review has
always behaved this way: only a new confirm, a stand-down or the send itself clears it. If the node was down and has
since recovered, a working network keeps showing P7-02's sentence until the next confirm.

**Options.**

- A. Leave it as it is. The next confirm checks again and clears the sentence or shows it anew.
- B. Clear every send error when a review is entered, so a fresh review starts blank. This changes when today's
  other send errors disappear too.

**What ships now.** A, unchanged, as for every send error today.

**Recommendation.** B, in a later arc. A fresh review should not carry an earlier attempt's sentence. It changes the
behaviour of every send error, so it is your call.
