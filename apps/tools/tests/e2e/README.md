# apps/tools/tests/e2e

Tools jsdom smoke — jsdom, no browser, no real wallet, no network: this one mocks the wallet and chain seams and mounts the app:

```bash
bun run --cwd apps/tools test:e2e
```

## `tools-smoke.test.ts`

Mounts the full `App.vue` against a **mock Aztec wallet provider** that intercepts the
`aztec-wallet-discovery` postMessage and answers canned RPC: the discovery handshake,
`establishSecureChannel` (deterministic `verificationHash`), `confirm`, `requestCapabilities`
(canned `granted.accounts`), `registerContract`, `executeUtility` (`0n` balances), `sendTx`
(a deterministic `txHash`). Pins the connect → verify → drip path.

## `send-smoke.test.ts`

Mounts `SendView` over the REAL wizard composables (catalog, selection, grant, route, gas share,
send, exit) and the REAL journal engine on jsdom's `localStorage`. Only the chain/wallet boundary
is faked: the generation manifest (`vi.mock("@/contracts/bridge-generation")`), the two wallet
sessions (`useL1Wallet`, `useWalletConnection`), and the bridge-core functions that would talk to a
chain. Everything between a click and those boundaries is production code. `fixtures/token-list.json`
is the remote list.

What it pins: discovery (manifest tokens first, the remote list after refresh, paste good and bad) ·
the grant is raised BEFORE anything is signed and a refusal sends nothing · a grant that lands for a
selection the user has left is discarded · a routeless token still sends with the gas choices
closed · the first-time paths (the review's note, register+claim, the private 2-tx rail) · gas-only
journals no token block · an exit reads both pause switches before it authorises a burn · a network
with no bridge block instantiates nothing.

bb.js poseidon throws under jsdom, so the two derivations a private send makes are faked with a
pure keccak stand-in that stays mutually consistent — the property the send depends on.

## Rules

- Selectors are **`data-testid` only** (`src/lib/testids.ts`; `testid-coverage.test.ts` asserts every
  interactive wizard element has one). Never text, role, placeholder or class.
- The chain/wallet fakes answer the SAME shapes the real seams return; when a bridge-core signature
  changes, the fake in the smoke changes with it (the typecheck sees the smoke — it is inside the
  app's tsconfig graph).

## What this does NOT cover

- Real testnet behaviour — the `packages/bridge-core` sandbox smoke (`deploy:sandbox --smoke`)
  proves the flows against a real local network, and the testnet canaries prove the live one.
- Cross-browser — jsdom is the only environment.
- `bb.js` wasm — mocked before any wasm runs.

## When a smoke fails after a dependency bump

- wallet-sdk: the mock in `fixtures/sdk-boundary.ts` probably needs a new RPC handler — check
  `src/composables/useWalletConnection.ts` for new SDK calls.
- aztec-standards: artifact import paths may have moved — re-check the mocked re-exports.
- bridge-core: a seam signature moved — update the send smoke's fake to the new shape.
