# Live-testnet deposit — PASSED ✅

The goal's live-testnet smoke: **100 USDC bridged Sepolia → Aztec testnet L2, end to end, with REAL proofs**, in **7.9 min**. Script: `bridge-core/scripts/deposit-testnet.ts`.

## Result
- `L2 public USDC balance = 100000000` (100 USDC) after `claim_public` — the full L1→L2 round-trip confirmed live on the real testnet.
- Deployed (testnet): usdc `0x6aa56dce…fc815`, portal `0xc69f3d66…dbcba`, proxy `0x073b97a0…3b819e`, token `0x1e06495c…12cf4d`, bridge `0x2e38201d…4832aa`. Deployer `0xFcc2238319aC360e985f1736aBB3df6251DAF6F5` (Sepolia, 0.187 ETH).

## Timing (real proofs)
- L2 Schnorr account deploy: **1.3m** (first real proof — feasible on this machine).
- minter-proxy 1.8m · token 2.2m · bridge 3.1m (~0.5–1m each) · wire + portal init 4.9m · deposit (L1) 5.4m · **claim synced 7.9m**.
- Per-tx proving: ClientIVC ~3s + private-kernel witness ~2s + public simulate ~2.4s. **Client-side proving is NOT a blocker** (~5–10s/tx; the wall time is L1/L2 inclusion + the inbox lag).
- **Claim sync ~2.5m** (deposit 5.4m → claim 7.9m): the testnet inbox lag. The live testnet's steady validator blocks make the claim land reliably — unlike a fresh local sandbox (idle-stall without `--sequencer.minTxsPerBlock 0`, or early-epoch reorg).

## How the testnet deploy differs from the sandbox
- `proverEnabled: true` (real proofs) vs sandbox `false`.
- L1 via the real `PRIVATE_KEY` (funded `0xFcc2…`) on Sepolia; **no `anvil_setCode`** for Permit2 (deposit doesn't touch Permit2 — that's the swap).
- A **fresh** Schnorr account (random secret → `deriveSigningKey` → `ensureAccountDeployed` with the `NO_FROM` sentinel) vs `getInitialTestAccountsData`.
- Sponsored FPC pays L2 gas → the deployer only needs Sepolia ETH.
- Deposit-only (no swap/pools — the swap is fork-proven in `bridge-evm/test/SwapBridgeRouterPermit2Fork.t.sol`).

## On the goal's "block-countdown bar"
The deposit + confirmation are proven live here at the SDK level. The *block-countdown bar* is the app's UI presentation of this same wait (`bridge-core/src/status.ts`); driving the deposit **through the app** (rendering the bar) against the testnet is the app-integration layer — the underlying round-trip it would display is now proven.
