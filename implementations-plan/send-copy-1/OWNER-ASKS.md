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
