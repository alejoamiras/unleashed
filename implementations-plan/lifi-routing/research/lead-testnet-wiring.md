# Research (lead): is "Base Sepolia → LI.FI → Across testnet → Sepolia → our contract" wired?

Lead-planner round. Read-only `cast` probes against public Sepolia / Base Sepolia RPCs, and four Across testnet API calls. No li.quest calls. Confidence **H** unless marked.

## Hop-by-hop wiring

| Hop | Evidence | Verdict |
|---|---|---|
| Base Sepolia diamond `0x816F…1770` routes `startBridgeTokensViaAcrossV4` (`0xa1f1ce43`) | `facetAddress(0xa1f1ce43)` = `0xed86e8F8…2B26` (the listed AcrossFacetV4) | wired |
| That facet deposits into Across's Base Sepolia SpokePool | `SPOKEPOOL()` = `0x82B564983aE7274c86695917BBf8C99ECb6F0F8F` = Across's published Base Sepolia SpokePool | wired |
| Base Sepolia Permit2Proxy `0xC55C…7A24` | `LIFI_DIAMOND()` = `0x816F…1770`, `PERMIT2()` = canonical Permit2 | wired |
| Canonical Permit2 on both chains | `cast code` identical on Sepolia and Base Sepolia | present |
| Sepolia ReceiverAcrossV4 `0x51Cd…0f44` | `SPOKEPOOL()` = `0x5ef6C01E…B662` (Across Sepolia), `EXECUTOR()` = `0x7b01…a533` (LI.FI Sepolia Executor) | wired |
| Sepolia Executor | code present; `erc20Proxy()` = `0xEd0D…C9Ac` (has code) | present |
| Sepolia diamond `0xeCeC…81F5` | 12 facets; AcrossFacetV4 `0x50eB…3Eb9` embeds the Sepolia SpokePool; `0x4666fc80` (GenericSwapFacetV3) routes to `0xa612…05F6` | present (irrelevant to the Base → Sepolia leg) |

Not yet proven on chain: that the deployed testnet bytecode behaves as `main` (M: Executor and ReceiverAcrossV4 runtime sizes equal mainnet's), and that a relayer fills a **message-bearing** deposit to the receiver. Both are exactly what the plan's feasibility phase tests.

## Across testnet (Base Sepolia → Sepolia)

- `available-routes`: USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` → USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`; WETH `0x4200…0006` → WETH `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`; native ETH (same pair, `isNative`); USDC → USDT `0x7169D38820dfd117C3FA1f22a697dBA58d90BA06`.
- `limits`: USDC min 2.089 / max 8.000 (instant 8.000); WETH min 0.000687 / max 0.00296 ETH.
- `suggested-fees`, 5 USDC, no message: relayer gas fee 0.522 USDC, total relay fee 0.5245 USDC (≈ 10.5 %), estimated fill 10 s, `fillDeadline` ≈ 2 h out, exclusive relayer zero. **A message-bearing fee quote was not run** (unknown whether the testnet API simulates `handleV3AcrossMessage`; round 1 saw `AMOUNT_TOO_LOW` for a ~500k-gas message).
- Relayer activity, ~50k blocks each side: Base Sepolia SpokePool 7 `FundsDeposited` (3 to Sepolia); Sepolia SpokePool 3 `FilledRelay`, all from Base Sepolia, by two relayer ids. A relayer is live on exactly this lane but traffic is a handful per window. Recipients not decoded (unknown whether any targeted the LI.FI receiver).
- Event signatures (verified): `FundsDeposited(bytes32,bytes32,uint256,uint256,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes32,bytes)`; `FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))`.

## Our Sepolia generation

- `factory.portalOf(Circle Sepolia USDC)` = 0 and `portalOf(Sepolia WETH)` = 0: **neither token Across delivers has a portal yet**. The router creates it inline on first use (~320–345k gas), or the conductor pre-creates it (`deploy:generation pre-create`, a live step).
- FeeAssetHandler `0x5602c39a…bfc9`: `FEE_ASSET()` = `0x762C…3C18` (the manifest's fee asset), `mintAmount()` = 1e21 (1,000 FJ), owner `0xdfe1…e924`. Upstream source (`aztec-packages`, `l1-contracts/src/mock/FeeAssetHandler.sol`): `mint(address)` is **permissionless, no rate limit**; a `cast call` simulation from a fresh address did not revert (M for the deployed bytecode matching that source).

## Feasibility verdict

Every hop's wiring is consistent on chain: our hand-built `startBridgeTokensViaAcrossV4` calldata (via Permit2Proxy or a direct diamond call) on Base Sepolia reaches Across's SpokePool, and a Sepolia `fillRelay` reaches LI.FI's receiver → Executor → any contract we name. What remains unproven is behavioural, and both halves are fork-testable before any key exists: (1) the facet accepts our calldata and emits `FundsDeposited` with our message; (2) a Sepolia fill of that relay runs the message through to our contract. Liveness is the open risk: relayers are sparse and the caps (≤ 8 USDC) sit near the fee of a heavy message, so the live canary must be able to **self-fill** (`fillRelay` is permissionless).
