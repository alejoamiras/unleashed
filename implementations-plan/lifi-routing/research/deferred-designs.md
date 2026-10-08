# Research: designs considered and deferred

Out of scope for this plan (owner decision: deposits only). Recorded so the follow-up starts from evidence.

## Exits: Aztec → any L2

- Today: `TokenPortalImpl.withdraw(recipient, amount, withCaller, …)` consumes the Outbox and transfers to `recipient`; the content is `withdraw(address,uint256,address)` with caller `0` unless `withCaller`. The app always commits caller 0 (`useHubExit.ts`, `flows.ts`). Consume waits for the epoch proof (app timeout 30 min; UI copy "tens of minutes").
- Guided hand-off (no contracts): after the exit lands in the user's Ethereum wallet, offer a LI.FI route to an L2 (second signature, needs ETH on Ethereum).
- Atomic forwarder: exit to a CREATE2 address `F = CREATE2(factory, H(destChainId, l2Recipient, minOutPolicy, maxRelayerFee, refundTo, userL1))`; a relayer consumes the Outbox message and calls `factory.deployAndForward(params)`; F forwards via an allowlisted bridge entrypoint with arguments it builds itself (never relayer calldata); refund to the salt-committed `refundTo` after a timeout. No Noir or portal change. Quote staleness (hours) → commit a slippage policy, not a quote.

## Counterfactual deposit address (transfer-only sources)

For providers that only transfer (NEAR Intents 1Click, plain bridges, exchange withdrawals): deposit address `D = CREATE2(factory, H(token, secretHash, isPrivate, aztecRecipient?, minAmount, maxRelayerFee, refundTo))`; anyone calls `factory.sweep(params)` to deploy D and deposit its balance. `minAmount` in the salt stops a dust-first sweep from splitting the deposit into extra leaves (which multiplies the user's claim cost). Needs a relayer (fee capped in the salt) or the user's own Ethereum gas. Non-atomic.
