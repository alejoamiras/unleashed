# Bridge L1 contracts (Foundry)

L1 contracts for the Unleashed any-ERC-20 bridge. Aztec L1 interfaces resolve to the installed
`@aztec-foundation/l1-artifacts` sources via the `@aztec/` remapping in `foundry.toml` — no
`aztec-contracts` submodule needed (the version matches `packages/bridge-core`'s pin).

## Dependencies (not committed — see `.gitignore`)

`lib/` is gitignored. Install before building — at the COMMITS CI pins (`_bridge-contracts.yml`),
not floating tags:

```bash
forge install \
  foundry-rs/forge-std@bf647bd6046f2f7da30d0c2bf435e5c76a780c1b \
  OpenZeppelin/openzeppelin-contracts@cab19933c33c2ad1d4c7a84864a3601dddfd16f3
forge install --no-git lifi-contracts=lifinance/contracts@rev=65bae143b249a5fba3dd27d506e9e1d6d8538899
# Upstream agent instruction files and .env templates must never reach an agent session or env-exec:
find lib \( -name .claude -o -name .agents -o -name .cursor \) -prune -exec rm -rf {} +
find lib \( -name .env -o -name '.env.*' -o -name CLAUDE.md -o -name AGENTS.md -o -name .mcp.json \
  -o -name '.cursorrules*' -o -path '*/.github/copilot-instructions.md' \) -exec rm -f {} +
```

> **LI.FI's destination half (`lib/lifi-contracts`, LGPL-3.0-only) is test and sandbox code only.**
> `[profile.lifi]` compiles Executor, ERC20Proxy, ReceiverAcrossV4 and ReceiverStargateV2 unmodified
> into `out-lifi/`, with LI.FI's own compiler settings, from one entry file (`lifi-build/LifiArtifacts.sol`).
> The default profile turns remapping auto-detection off, so the lib adds no remapping there and its
> contracts cannot resolve their own imports outside `[profile.lifi]`; suites load its artifacts by path.

> OZ is pinned to 5.7.0 for `Clones.cloneDeterministicWithImmutableArgs` + `ReentrancyGuardTransient`.

## Build / test

The `@aztec/` remap resolves through `packages/bridge-core`'s installed `@aztec-foundation/l1-artifacts`.
Under the repo's isolated linker that package is NOT at the repo-root `node_modules` the static
`foundry.toml` remap assumes, so generate the override file first (gitignored). CI and the
sandbox's forge step generate it; `verify-l1.ts` does not, so run this before `verify:l1` too:

```bash
# from this directory (contracts/bridge/evm):
bun --cwd ../../../packages/bridge-core scripts/gen-remappings.ts   # writes ./remappings.txt
forge build
FOUNDRY_PROFILE=lifi forge build                                     # LI.FI's destination half → out-lifi/ (CI)
forge test --no-match-contract Fork                                  # hermetic (CI)
SEPOLIA_RPC_URL=… AZTEC_REGISTRY=… forge test --match-contract Fork   # live forks (opt-in; each skips without its endpoint, FactoryFork without the registry)
LIFI_LIVE=1 bun ../../../packages/bridge-core/scripts/lifi-fixtures.ts --run   # LI.FI: fresh fixtures, then every Lifi*Fork at their blocks (opt-in)
ETH_RPC_URL=… BASE_RPC_URL=… forge test --match-contract '^Lifi(Destination|StargateCompose|Replay)Fork$'   # replay the committed mainnet fixtures (archive RPCs)
forge build --ast --force && halmos --match-contract '^Formal'       # symbolic proofs (CI)
forge snapshot --match-test test_gas_ --no-match-contract Fork --check --tolerance 2   # .gas-snapshot (CI)
```

## Contracts

- **`PortalFactory`** — creates one storage-less **portal clone per ERC-20** (OZ `Clones` with the
  token as an immutable arg, salt = the token address) and sends the L2 hub a `register` message
  carrying `(token, portal, nameWord, symbolWord, decimals)`. Idempotent; permissionless; the
  factory is the message's L1 sender. Its owner is the **guardian**: two pause bits (deposits,
  withdrawals — a delay, never a transfer of funds) behind `Ownable2Step`, renounce disabled.
- **`TokenPortalImpl`** — the implementation every clone delegates to. Canonical `TokenPortal`
  content hashes byte-for-byte (`ContentHash.t.sol` + the Noir keystone), plus guards that never
  touch the hashed preimage: pause bits, `amount ≤ uint128.max`, exact-in (fee-on-transfer refused),
  exact portal-debit on withdraw, transient reentrancy guard. No storage, no initializer.
- **`DepositRouter`** — deposits a token into its clone and, optionally, swaps a slice of it into Fee
  Juice for the same recipient's gas through the immutable `SWAP_TARGET`. Two entrypoints settle
  through one path: `bridgeWithPermit` (an Ethereum EOA's Permit2 witness signature) and
  `bridgeFromCaller` (any caller that already holds the funds — LI.FI's Executor after a bridge
  delivers them). Creates the clone inline on a token's first deposit.
- **`TestnetFuelSwapper`** — the testnet `SWAP_TARGET` (see INFO-2); mainnet's is LI.FI's Diamond.
- `MintableERC20` / `TestUsdc` — capped-mint test tokens (testnet only, see INFO-1).

## Deploying

Nothing here deploys. The TypeScript conductor (`packages/bridge-core/scripts/deploy-generation.ts` —
nonce-pinned factory prediction, journalled, candidate-first) deploys from `out/`; runbook in
[`bridge-generation`](../../../.claude/skills/bridge-generation/SKILL.md), Branch B.

## Tests

**161 hermetic forge tests** (`forge test --no-match-contract Fork`), **15 halmos proofs**
(`FormalDepositRouterTest 11 · FormalFactoryTest 2 · FormalCloneTest 2`; the guard-shaped ones carry a
forge canary proving the property fails without the guard), **live fork suites** (the real Sepolia
registry/Inbox/FeeJuicePortal, real Permit2, LI.FI's deployed contracts, live token metadata), and a
committed `.gas-snapshot` for the metered first-time vs known `bridgeWithPermit()` and a fueled
`bridgeFromCaller()`.

| Layer | Suites |
|---|---|
| unit | `PortalFactory`, `CloneWithdrawRealOutbox` (a clone against Aztec's real `Outbox`: replay, caller binding, cross-clone proofs — the other suites' capturing fake accepts anything), `DepositRouter`, `TestnetFuelSwapper`, `Keystone` (3-way vectors with Noir + TS), `ContentHash`, `DepositWitness` (the vector the TS witness pins) |
| fuzz | `PortalFactoryFuzz`, `CloneRoundtripFuzz`, `DepositRouterFuzz` |
| invariant | `PortalFactoryInvariant`, `DepositRouterInvariant` (Executor, Permit2 user, donor, hostile venue, pause, sweep) |
| symbolic | `FormalFactory`, `FormalClone`, `FormalDepositRouter` — see the header of each for what halmos can and cannot model (it has no sha256, so `createPortal` itself is forge-only) |
| adversarial | `BlackhatFactory` (F-1…F-9), `DepositRouterBlackhat` |
| fork | `FactoryFork`, `DepositRouterPermit2Fork` (real Permit2 on a mainnet fork, `ETH_RPC_URL`) |
| LI.FI fork | `LifiTestnetRailFork` (Base Sepolia → Across → Sepolia through LI.FI's deployed Diamond, receiver and Executor, into a portal or the router and swapper), `LifiDestinationFork` (Ethereum's receiver and Executor into the router: venue set, RFQ expiry, gas pin, recovery), `LifiStargateComposeFork` (compose gas floor and recovery), `LifiReplayFork` (a Base source transaction replayed into Ethereum's `lzCompose`) |

## Threat model — the factory-bound portal

What a clone trusts: the factory it was cloned from (immutable `FACTORY = msg.sender`, whose pause
bits it reads), the Aztec registry the factory bound at construction (Inbox/Outbox/version are
implementation immutables), and its own token (an immutable arg in its bytecode — nothing to
repoint, no initializer to front-run). What the factory reads from a token is sampled once, gas-
capped and bounded: a hostile `name()`/`symbol()` can only poison the two cosmetic words (sanitized
to printable ASCII, frozen at creation, never trusted for anything but display), a missing
`decimals()` refuses the portal, and a front-runner creating a token's portal first produces the
byte-identical portal, registration and message the honest caller would have (`BlackhatFactory`
F-1…F-8). The remaining trust is the guardian (a pause is unbounded in time by design — it can
freeze deposits or withdrawals indefinitely, but never move funds) and the router owner's `sweep`,
which reaches only donated residue.

## Threat model — `DepositRouter`

The router never takes a portal from its caller: every leg's destination is derived from the token
(token leg into the token's own clone, fuel into the canonical `FeeJuicePortal`, a partial fee-asset
remainder into the fee asset's clone), and two more rules hold:

- **The caller path spends only the caller's funds.** `bridgeFromCaller` is unsigned and permissionless,
  so it pulls from `msg.sender` alone, at most `min(balance, allowance, maxPull)`; `bridgeWithPermit`
  passes `msg.sender` to Permit2 as the owner, so nobody else can spend a user's witness signature.
  Accounting is by deltas: a donation never joins or reverts a deposit, and the owner's `sweep` is the
  only thing that reaches it.
- **The swap call is fixed at construction.** `SWAP_TARGET` is immutable, `swapData` must carry one of
  two pinned `GenericSwapFacetV3` selectors with `_receiver` equal to the router (a full-word compare),
  and a non-zero `minFuelOutput` floors the router's own Fee Juice delta, so a selector-valid call that
  pays someone else reverts. The target's `fuelSlice` approval is exact and revoked after the call.

## Value-token hard-blockers (MUST clear before any non-testnet deployment)

- **INFO-1 — `MintableERC20` / `TestUsdc` are not value tokens.** `mint` is permissionless (capped
  per tx), and `MintableERC20` additionally treats every holder as having granted canonical Permit2
  infinite allowance (`TestUsdc` does not — it is the plain-allowance control).
  Faucet-by-design and **not** a theft path (Permit2 still needs the holder's signature), but a
  severe footgun if copied to a real asset. A value deployment MUST use a token with
  access-controlled mint and no forced allowance.
- **INFO-2 — `TestnetFuelSwapper` is testnet-only.** It pays Fee Juice at an owner-set rate from inventory
  and the testnet faucet, and its constructor refuses chain id 1; mainnet's `SWAP_TARGET` is LI.FI's Diamond.
- **Rebasing tokens are unsupported** (the clone's reserve accounting assumes a static balance);
  fee-on-transfer tokens are refused on chain.
