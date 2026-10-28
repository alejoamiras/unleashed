# Phase 5: the two-anvil integration test

- Measured: `test:integration` takes about 5.4 s end to end on this host (two anvils booted, four contracts placed,
  six scenarios in 0.7 s), against the estimate of 30 s. Stable over four consecutive runs at retry 0; no row left
  in the port registry, no anvil left running.
- Anvil answers `eth_maxPriorityFeePerGas` with a fixed 1 gwei whatever its flags (`--disable-min-priority-fee`
  included), so a fill at the gas cap would read about 0.017 ETH and trip the relayer's `gas-price` pause. The
  suite's destination transport answers Sepolia's 2 wei instead, and anvil runs at a 7 wei base fee; the
  production code is unchanged.
- `MintableERC20` keeps its decimals and mint cap in immutables, which the artifact's `deployedBytecode` leaves zeroed:
  the suite deploys each mock and copies the deployed runtime code to the real address instead.
- First run: one scenario sent three deposits from one account concurrently and hit `nonce too low`; sending them in
  turn fixed it.
- Mutation check: matching fills by `depositId` alone fails S6 on chain.
- The worktree needed `forge install --no-git` of forge-std and OpenZeppelin at the setup-forge pins (the LI.FI lib
  serves only the `lifi` profile) and `gen-remappings.ts`; `forge build` took 54 s.
