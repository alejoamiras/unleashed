# Phase 0b: revision for ask60

- What makes a press necessary today, traced on 7de51e7: no re-arm after wait B; every watch read through the
  wallet's provider; reload resumes only with the Aztec wallet connected at boot (a grant gate, irrelevant to an L1
  watch); a second tab gets `HELD_ELSEWHERE` and never takes over.
- The build already has a wallet-independent L1 reader (`readClientFor`), used by claims and the token-block check;
  the sandbox build pins anvil through it, so e2e exercises the reader path.
- The wizard's full stepper offers a control only on a failed phase: any "stop watching, not failed" state needs its
  own control there, or the stepper shows a stale prompt and estimate with no way forward.
- Mocking the stepper: the wizard adopts only its own run, so the mocks mount the real `BridgeStepper` over the
  send panel through the dev server's own Vue module (`performance` resource URL of `/deps/vue.js`), never a second
  Vue copy.
- A speed-up made while no wait runs cannot be followed (viem needs the original fetched in that wait): copy that
  suggests speeding up must say to press first.
- Codex on the revision: a round count is not a time bound when rounds can end early; a busy flag cleared between
  rounds exposes the control; viem's `fallback` accepts the first endpoint's `null`, so a multi-endpoint reader needs
  an explicit per-endpoint probe for both absence and a receipt; settle writes must be conditional on the observed
  hash, since the engine runs unlocked where Web Locks are missing.
