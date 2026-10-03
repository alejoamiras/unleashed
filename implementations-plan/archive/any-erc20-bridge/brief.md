# Brief — any-erc20-bridge (planning packet)

Read with `recon.md` and `research/*.md` in this directory. Everything under "Locked" is an owner decision — plan against it, do not re-litigate it; attack it only in the Assumptions/Security sections if you believe it is unsafe, and say so explicitly.

## Task

Make the tools app (`apps/faucet`, the L1↔L2 bridge + fuel UI) bridge **any ERC-20** between Ethereum and Aztec permissionlessly, with **swap-in-place fuel** (any token → Aztec gas), a new **3-step wizard UI**, rewritten **deploy conductors**, and a test bar at least as strong as the shipped hardening arc (forge unit + fuzz + invariant + halmos; Noir keystone + TXE; bridge-core vitest; faucet unit + smoke; sandbox end-to-end).

## Locked decisions (owner)

**Architecture**
- **L1 `PortalFactory`**: deploys per-ERC-20 portals as OZ `Clones.cloneDeterministicWithImmutableArgs` (OZ 5.6.1 installed) with `salt = keccak256(erc20)`; the clone's immutable args carry `underlying`; the portal implementation carries the shared Aztec pointers (`registry→rollup, inbox, outbox, rollupVersion`) and `L2_HUB` as constructor immutables. **No `initialize`, zero storage per portal.** `createPortal(erc20)` reads `IERC20Metadata`, sends an L1→L2 `register` message through the new portal, emits `PortalCreated(address indexed token, address portal, string name, string symbol, uint8 decimals)`. `createPortalAndDeposit…` batches creation + deposit in one tx. Deposit/withdraw bodies stay byte-identical to the forked portal so content hashes do not drift.
- **Guardian**: one `Ownable2Step` guardian on the factory with two pause bits — deposits and withdraws — read by every clone. No per-portal owners. No mutable "parameters" contract (rejected: institutionalizes the F-001 repoint-and-drain class).
- **L2 `TokenBridgeHub`** (ONE ownerless contract, replaces `token_bridge` + `token_minter_proxy`): stores `portal_of: Map<AztecAddress /*l2 token*/, PublicImmutable<EthAddress>>` (+ a public `token_of(erc20)` map for discovery); derives `portal(erc20)` by CREATE2/keccak in public; **deploys per-token aztec-standards `Token` instances itself** (Wonderland `vault_deployer` pattern: derive `{salt: H(erc20), deployer: HUB, class: TOKEN_CLASS, init: constructor_with_minter(name, symbol, decimals, HUB, ZERO)}`, `publish_contract_instance_for_public_execution` in private, enqueue the public constructor) after consuming the L1-attested `register` message. Claims/exits generalize today's bodies (F-007 `derive_claim_secret` recipient commitment kept verbatim). Genesis cycle broken by a one-shot deployer-only `bind_l1(l1_factory, portal_init_code_hash)`.
- **Router**: A-1 closed structurally — `bridge`/`bridgeWithFuel` require `tokenPortal == factory.portalFor(bridgeToken)` (fee-asset direct fuel keeps `tokenPortal == feeJuicePortal` when `bridgeToken == feeJuicePortal.UNDERLYING()`); swap-in-place fuel = `bridgeWithFuel` with `fuelAmount == totalAmount` (skip the token leg). Keep the 12-field Permit2 witness. V4-hookless routes only; "no route" is a first-class outcome. No V3 leg.
- **Token list**: runtime fetch of the Uniswap default list from ONE pinned origin (`https://tokens.uniswap.org`), localStorage TTL cache, zod schema validation at the boundary, **logos from a bundled SVG sprite only** (no live `logoURI`), monogram/hue fallback. Paste-any-address reads metadata on-chain. (Owner chose runtime fetch over a bundled list; the mitigations above are agreed.)
- **Cutover**: retire the legacy single-token bridges (mainnet Circle USDC, testnet TestUsdc); USDC gets a new L2 token under the hub. Old contracts stay deployed but leave the manifest/UI.
- **Noir line stays at v5.0.1** (the repo's deliberately held line; every API the hub needs exists there — see `recon.md`).

**UX (Direction D "Wizard")**
- Token → Amount → Review; in-flight stepper continues the numbering. Token list has **no status chips** — logos (bundled) + striped monogram fallback + "paste an address" with one caution line.
- Amount step = three cards `TOKEN / TOKEN + gas / Gas`; choosing "+ gas" reveals a two-line breakdown (arrives / becomes gas) with the gas share **proposed** from a tx-count target and a "change" link; privacy is one row "Private — only you can see it" (private by default). No "note", "portal", "register" outside Details. AZTEC (the fee asset) uses the SAME layout; its "Gas" is 1:1 with no route line; its "TOKEN" outcome bridges it as a wrapped token through its own portal.
- Review = five lines (send / arrives / gas / network fee / takes) + collapsed **Details** (route, slippage, portal "verified" by client-side recomputation, account, signature validity, "what you're signing"). First-time token = a soft note about time + cost ("once, ever") + a red "no gas from X" line when applicable. No addresses in the main review.
- Exits (L2→L1) for any hub token go through the same wizard.
- Every new interactive element gets a `TESTIDS` entry; e2e selects by testid only.

## Clarifying answers (Phase 0)

- **Done** = testnet live (factory + hub deployed on Sepolia/alpha-testnet by the conductor; blue chips pre-created — on testnet these are freshly deployed fake USDC/WETH/USDT/cbBTC/WBTC like today's `MintableERC20`/`TestUsdc`; wizard live on `testnet.app.unleashed.systems`) **+ documentation updated everywhere** (deploy runbook in the `aztec-update` skill, READMEs, UPDATE.md couplings, CLAUDE.md pointers). Mainnet deploy is out of scope (a later owner-run step gated by `/harden security`).
- **In scope**: L2→L1 exits via the wizard; blue-chip pre-creation in the conductor; the full test bar.
- **Out of scope**: TXE in CI (stays a local per-phase gate); changes to the wallet; V3 swap leg; mainnet deploy.
- **Gates**: fast layers always (`bun run lint`, `bun run typecheck:all`, package vitest); forge hermetic + halmos on every contract phase; **Sepolia fork tests** (`SEPOLIA_RPC_URL`) on router/factory phases; **TXE locally** (`contracts/bridge/aztec/scripts/run-txe-tests.sh`) on every L2 phase; **`bun run --cwd packages/bridge-core deploy:sandbox --smoke`** (local aztec sandbox + anvil, runs alone) at integration phases; **owner live-testnet sign-off** as the final gate before merge.
- **Post-implementation**: `/harden security` before any mainnet deploy (recorded, not scheduled by this plan).
- **Budget**: codex `xhigh`; `/code-review medium` per arc; recon done.

## Non-negotiables

- Never weaken a gate. Contracts under `contracts/bridge/**` run in CI via `contracts.yml` — keep it green; add the new suites to it.
- Keystones (content hashes, claim secret, witness, route, class ids) stay green with zero vector edits unless a vector is deliberately ADDED (register hash, CREATE2 address, hub token address).
- Comments: value per character, invariants and non-obvious whys only, no plan/phase references.
- No absolute local paths in committed files.
