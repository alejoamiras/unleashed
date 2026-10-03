# Arc 5 — formal verification: tooling research + outcome

## Tool survey (time-boxed half day)

| Tool | Verdict | Why |
|---|---|---|
| **Halmos 0.3.3** (a16z) | ✅ CHOSEN | OSS, pip-installable, Foundry-native (`halmos --contract X` against the existing project), symbolic args on plain test fns. **via_ir=true compiled fine** (the feared blocker did not materialize). |
| Certora Prover | ❌ skipped | Commercial license + cloud prover; wrong shape for a time-boxed NIT arc. |
| Kontrol (Runtime Verification) | ❌ skipped | KEVM-based; heavier install than Halmos for equivalent expressiveness here. |
| echidna | ❌ n/a | Fuzzer, not symbolic — redundant with the Foundry fuzz suites from Arc 4. |

## What got proved (all PASS, whole input domain)

`contracts/bridge/evm/test/FormalRouter.t.sol`, run via:
`halmos --contract FormalRouterTest`

- `check_bridge_conservesUserFunds(uint128)` — for EVERY affordable amount: user delta ==
  amount, portal deposit == amount, router residue == 0.
- `check_bridgeWithFuel_conservesUserFunds(uint128,uint128)` — for EVERY affordable total AND
  every valid fuel split (120 symbolic paths): token leg == total−fuel, fuel leg == reported
  output, zero residue of both tokens.
- `check_sweep_revertsForNonOwner(address)` / `check_setSwapTarget_revertsForNonOwner(address)` —
  authority boundaries hold for ALL non-owner callers; rejected calls mutate nothing.

Threat model: Permit2 is a success-always mock (signature validity is Permit2's own domain,
pinned by the real-fork tests) and the swap target is the honest mock — the proofs cover the
router's OWN accounting guarantees under those semantics.

## Gotchas that cost time (documented for the next person)

1. **`makeAddr` breaks halmos**: the address stays an uninterpreted `f_vmaddr(...)` term, so a
   balance minted to it in setUp and a later `balanceOf` read can disagree in the solver's eyes,
   producing phantom counterexamples. Use literal `address constant USER = address(0xDA0);`.
2. **`vm.expectRevert` is unsupported** (HalmosException) — express revert-expectations with
   `try ... catch { assert state unchanged }` instead.
3. Counterexample values are RAW symbolic inputs; the failing assertion name appears inside the
   `FailCheatcode(...)` payload of the `-vv` trace — read that before debugging anything else.
4. StdUtils `bound()` works fine on symbolic inputs — no manual range logic needed.

## Scope honesty

These are bounded model checks of the router in isolation, not end-to-end protocol proofs: the
swap target is modeled honest, Permit2 is modeled success-always, and UniswapFuelSwap/V4 are out
of scope (their settlement is covered by the real-PM fork tests + grammar fuzz instead).
Extending to the hostile-target space would require constraining an abstract external contract —
a natural follow-up if this arc earns its keep.
