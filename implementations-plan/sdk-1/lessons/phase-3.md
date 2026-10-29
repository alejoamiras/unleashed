# Arc a3: the app on the SDK, and ask3

- **3.1: a fake of an SDK run must fail the way the SDK fails.** The app reads a refused seal through the SDK's
  `persist-failed` wrapper; a fake that let the app's own error escape bare passed a refusal check that the real run
  would fail. Mutations of the approval carry and the refusal walk survived until the fake wrapped persist failures and
  wallet errors as the SDK does.
- **3.1: a public deposit entry that re-sizes its quote cannot carry a reviewed number.** `depositFuel`/`depositToken`
  take only quotes the SDK made, sized afresh; an app that shows a slice and a floor on its review signs through the
  internal `depositL1` with the reviewed plan (plan D59).
- **3.1: a deadline drawn before a wait expires inside it.** The Permit2 deadline was read before the approval, whose
  receipt can wait out the whole window; it is drawn right before the signature now (plan D62).
- **3.1: fake timers prove a wait's edge.** `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` checks the
  receipt wait still holds a tick before 180 s and aborts at it, without a real wait and without faking the promise
  queue the run needs.
- **3.2: li.quest's same-chain quote calls the multi-swap entry.** The recorded `deadlineFree` quote is
  `swapTokensMultipleV3ERC20ToERC20` (LI.FI's fee step, then the swap); `TestnetFuelSwapper` answers only the
  single-swap entry, so the browser fixture re-encodes the recorded swap leg as a single call. The SDK pins both
  selectors, so the checks it runs are the mainnet ones.
