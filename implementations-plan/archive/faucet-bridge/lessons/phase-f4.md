# F4 — deposit flow (testnet) — IN PROGRESS

## Decisive finding: the faucet's testnet USDC is Dripper-minted, not proxy-shared
`deployments.json`: USDC + ETH use `constructor_with_minter` with `minter = 0x172684be…`, which **equals the Dripper address** (`dripper.address = 0x172684be…`). So the faucet's L2 USDC is minted **directly by the Dripper** — there is NO `token_minter_proxy` in front of it. The bridge therefore CANNOT mint the faucet's exact USDC (the Dripper is the sole minter; the bridge isn't authorized).

The `token_minter_proxy` (whose stated purpose is "Dripper AND bridge mint the same token") was used in the sandbox deploy + `deposit-testnet.ts`, but the live faucet testnet deploy did not put USDC behind it.

## Decision (A): the bridge deploys its OWN persistent testnet set
- "Bridged L1 asset = same L2 asset" means L1 USDC → L2 USDC **1:1, not wrapped** — which the bridge's OWN USDC satisfies. It does NOT require sharing the faucet's separate drip-USDC instance.
- So: the bridge deploys its own persistent set — **L1**: MintableERC20 USDC + canonical TokenPortal (Sepolia); **L2**: token_minter_proxy + Token(minter=proxy) + token_bridge(proxy, portal). Non-disruptive (the faucet's drip-USDC + Dripper untouched).
- Trade-off: the Bridge tab's USDC ≠ the Faucet tab's drip-USDC (two instances on testnet). Acceptable for testnet.
- **Rejected (B): redeploy the faucet's USDC behind a shared proxy** (Dripper + bridge both mint it) — truly one shared token, but disruptive (changes the faucet's USDC address + config, breaks held balances). Not worth it on testnet unless the user wants unified balances.

## F4 plan
1. `scripts/deploy-bridge-testnet.ts` — persistent deploy (FIXED salts → deterministic addresses) + write `public/testnet-bridge.json` (L1 addresses + L2 {address, salt, constructorArgs, constructorArtifact} for instance-rebuild).
2. `src/contracts/bridge-deployments.ts` — rebuild the L2 instances from the config (mirrors `deployments.ts`).
3. `useBridgeWallet` — `createAztecWalletSession` + `buildBridgeManifest` + `registerBridgeContracts` (the rebuilt instances).
4. Deposit flow — L1 (`useL1Wallet`: mint/approve/depositToAztecPublic) → L2 (`useBridgeWallet`: poll claim_public) via bridge-core, boundary at primitives. Block-countdown bar (`status.ts`). Recovery (persisted secret).
5. Playwright-MCP drive vs testnet.

Next: build + run the persistent deploy (~8 min + gas on the funded `0xFcc2…` key).

## Implementation (UI + logic complete; manual end-to-end test pending)
- **Persistent deploy**: `deploy-bridge-testnet.ts` → the bridge's own testnet set — L1 USDC `0x79e7…` / portal `0xde84…`; L2 proxy `0x0c44…` / token `0x05d8…` / bridge `0x13e5…`. Config at `faucet/public/testnet-bridge.json`. 5.3 min, real proofs, no reorg.
- **Artifact access**: `bridge-aztec` is a Noir package (no package.json), so `bridge-core` re-exports the L2 Noir artifacts (proxy + token_bridge) via a new `./artifacts` subpath (isolated from the viem-typed flows). `bridge-deployments.ts` rebuilds the L2 instances from the config (same salt + `universalDeploy` → addresses agree by construction). tsc handles the 1.7M artifacts (explicit `ContractArtifact` return type).
- **Wallets**: `useBridgeWallet` — the bridge's Aztec L2 session (`createAztecWalletSession` + `buildBridgeManifest` + `registerBridgeContracts`). `useL1Wallet` fixed to a module-level singleton — was per-call, so the panels + `useDeposit` wouldn't share the connection.
- **Deposit**: `useDeposit` — faucet-side orchestration (L1 mint → approve → `depositToAztecPublic` via `useL1Wallet`/canonical viem + `TokenPortalAbi`; L2 poll `claim_public` via `useBridgeWallet` + `Contract.at` + sponsored FPC). Boundary at primitives (no viem types crossed). Secret persisted to localStorage BEFORE the irreversible L1 deposit (recovery). `DepositCard` (amount + stage progress bar) + `BridgeWalletPanel` (L2 connect, verify-emoji) wired into `BridgeView`. Renders faucet-quality (Playwright snapshot); lint + tsc + 128 tests + build green; 0 console errors.

## Manual test = the GREEN-through-the-app proof (needs the user's wallets)
Headless Playwright can't drive Rabby + the Aztec wallet through real client-side proofs. The real deposit is a manual run: connect Rabby (Sepolia) + the Nulo Aztec wallet → enter an amount → Deposit → mint/approve/deposit (L1) → claim (L2, ~1 min). This validates the wallet-UX + in-browser proving — which F6 (withdraw/swap) shares — so validate before mirroring.

## Block-countdown bar
F4 ships a stage-progress bar (minting → approving → depositing → claiming → done) + the "~1 min" claiming message. The precise blocks-remaining countdown is most meaningful for the WITHDRAW's proven-epoch wait (the testnet epoch-proving lag), so it's built with F6.
