# Phase 0: recon and planning

## Live read-only evidence

- PublicNode Sepolia: `deployedHash(getCode, CODE_PINS[c]) === pin.hash` for DepositRouter `0x6e55…035b`,
  PortalFactory `0x2509…7817`, TokenPortalImpl `0x4346…9f1e`, TestnetFuelSwapper `0x2b22…86ab`.
- Raw `getCode` keccak identical on PublicNode and the Tenderly public gateway for all four. dRPC's keyless Sepolia
  answers "chain is not available on free plan".
- Keyless testnet node `node_getContract(0x1d50…7530)`: current and original class `0x2132…2abe`, equal to the HEAD
  hub target's class; the HEAD target derives the manifest's hub address.
- Hub target sha256 `d7e3be3c…328a` equals `artifacts.noirTargets` in `archive/aztec-6-stable/lessons/intent.json`.

## Consults
- Every immutable span in `code-pins.json` is 32 bytes and sits at a `PUSH32` operand (`0x7f`) of the live code
  (DepositRouter 18, PortalFactory 9, TokenPortalImpl 17, TestnetFuelSwapper 8); every trailer is 53 bytes.

- Round 1, Codex (`gpt-6.1-sol`, high, session `01a18917-a0da-7720-9aef-2bed8d3bc74e`): conditional approve, 7 findings
  (3 High: HEAD derivations in promotion checks, carry baseline in the allowlisted tree, merge-base provenance wrong
  for carried entries). All adopted; see plan.md § Round 1 audit verdicts.
- Round 1, Opus (Plan agent): conditional approve, 9 findings (tooling artifact, mask bounds, mainnet placeholder,
  per-entry build, verify-l1 record option, promote details, `hubArtifact(net)`, explicit ABI map, sandbox-only HEAD
  pins). All adopted except the tree-id form of `build`.
- Final fresh pass, Codex (`gpt-6.1-sol`, high, new session `01a18928-ab56-78e1-a800-ec8940d79be5`): conditional
  approve, 4 findings (candidate vs baseline lookup conflated; D3 inputs short of setup-forge's digest list;
  no-record verifier path could serve a live chain; no second RPC at promotion). All verified and adopted. Resumed:
  `approve`.
