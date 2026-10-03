# Faucet-Bridge — follow-ups (filed during manual testnet testing; not blocking)

Deferred so flow-testing isn't interrupted. None are funds-at-risk.

## 1. Contracts footer no longer links to the Aztec explorer
`packages/faucet/src/components/Footer.vue` links each contract (USDC / ETH / Dripper) to the explorer, gated on `links.*` derived from `VITE_EXPLORER_BASE_URL`. They currently render as **plain text** (no `<a>`). Either the env var is unset in this build, or the F1 tabbed-shell refactor (`App.vue` → `views/FaucetView.vue`) stopped passing the resolved links into `Footer`. **Fix:** confirm `Footer` receives the explorer links and re-add the hrefs. Also — the **Bridge tab has no contracts footer at all**; add one for the bridge's L1+L2 contracts (USDC/portal on L1, proxy/token/bridge on L2 from `testnet-bridge.json`).

## 2. "Add to wallet" adds the faucet's token, not the bridge's
The faucet's add-token registers the **faucet's** USDC/ETH (`@/contracts/deployments`). The bridge uses its **own** USDC (`@/contracts/bridge-deployments` — a separate deployment with a different address). They're distinct tokens **by design** (the bridge deployed its own set). So on the Faucet tab the add-token is correct (the faucet's USDC); the **bridged** USDC is a different token the faucet's add-token does NOT add — which is why bridged balance won't show up under the faucet's added token. **Decision needed:** (a) unify — point the faucet at the bridge's USDC so there's one token, or (b) keep separate + add a bridge-side "Add to wallet" for the bridged token. Until decided, document the distinction in the UI so it's not confusing.

## Earlier deferred (also tracked in `lessons/phase-f7.md`)
- **Seal the deposit claim secret** via bridge-core `recovery-crypto` — required once private claims land (the secret becomes a bearer credential). Plaintext is acceptable for public claims today.
- **No-wallet CTAs** — `BridgeWalletPanel` / install prompts when no Aztec or Ethereum wallet is present.
- **Swap flow** — needs a seeded Uniswap V4 pool for the bridge's USDC on testnet; currently fork-proven only (`bridge-evm`, 32 tests).
