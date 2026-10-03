# Phase 2 — Noir line

Status: **✓.** Recompile, TXE 65/65, the keystone vectors, forge 157/157, the snapshot check, sole-consumer and halmos 12/12 all pass (§ Unblocked, § Halmos).

## Done

- **Vendored content-hash crate** `contracts/bridge/aztec/token_portal_content_hash_lib/`:
  - Source: `aztec-labs-eng/aztec-node` tag `v6.0.0-rc.1`, which is annotated tag `8224dd38…` peeling to commit `68274e7c39c6388975aab5ee6ada8e4764d619ec`.
  - `lib.nr` is 2971 bytes with sha256 `5e20eaf6…fd991`, and is **byte-identical to the v5.0.1 lib**, so no content-hash vector can move.
  - The header carries the commit, the digest and Apache-2.0.
- **Tag SHAs** (Nargo pins by tag; the tags are recorded here for audit):
  - `aztec-labs-eng/aztec-nr` `v6.0.0-rc.1`: annotated `45301798…`, which peels to commit `88ff1ded43051ed5393150799f4308aeda46e94a`.
  - `AztecProtocol/aztec-standards` `v6.0.0-rc.1`: lightweight tag, commit `cdfba943f59ae50cfb46f8c5e16fcce72d9abb42`.
- **One `aztec` crate**: aztec-standards' `token_contract` names `https://github.com/aztec-labs-eng/aztec-nr` with **no trailing slash**. Our four manifests and the vendored crate use the identical string. The v5 manifests had used `aztec-packages/` with a slash; copying that habit would risk a second crate.
- **Scripts**: `compile.sh`, `nargo.sh` (which replaces `nargo-5.sh`, no callers) and `run-txe-tests.sh` default `AZTEC_HOME` to `~/.aztec/versions/6.0.0-rc.1`. The TXE paths are `@aztec-labs/txe`. The `compile.sh` CLI and `bb` paths (`$AZTEC_HOME/node_modules/.bin/{aztec,bb}`) are **unverified against the v6 layout**, because the partial install has no `node_modules`. Check them on the first real install.
- **txe-server**: `@aztec-labs/txe@6.0.0-rc.1`. The lockfile was re-resolved from the committed one with `--minimum-release-age=604800` and is byte-identical to the ungated resolution, so it is minimal-drift and gate-clean. A from-scratch resolution drifts the whole aws-sdk tree, so don't delete the lockfile to regenerate it.
- **CI tag readers** take `head -1` of the two `aztec-nr"` matches (aztec, compressed_string). Both give `6.0.0-rc.1`.

## Partial validation (v6 nargo from the partial install, `internal-bin/nargo`, noir 1.0.0-rc.3)

| Check | Result |
|---|---|
| `keystone` `nargo test --force` | **10/10 pass**: content-hash vs L1, claim-secret vectors vs TS, both DOM_SEP pins, the register hash. **I3 resolved**: the DOM_SEP literals hold on v6. |
| `token_bridge_hub` `nargo check` | passes. Its one new warning (an unneeded `mut` in `test/pause.nr`) is fixed. |
| `gen-remappings.ts` | passes; its forge assertions ran once `lib/` was populated (`forge install --no-git`, CI's pinned commits) |
| `forge build` | exit 0 |
| `forge test --no-match-contract Fork` | **157/157 pass** across 21 suites, `ContentHash.t.sol` included |
| `forge snapshot … --check --tolerance 2` | pass (local forge 1.4.1; CI pins 1.7.1) |
| `check-sole-consumer.sh` | holds: 3 sites, `claim_private` derives |
| halmos | **not run**: halmos/pipx aren't installed here, and I didn't add a tool install while the owner was away. CI runs it. |

## Blocked

`compile.sh --check`, the committed `target/*.json` recompile, `run-txe-tests.sh`, and the `noir-artifact-classids` / `hub-token` re-pins all need `aztec compile` (nargo + AVM transpile + VKs), and `run-txe-tests.sh` needs `$AZTEC_HOME/bin/aztec-nargo`. The v6 install stopped at the foundry step because other agents' anvils were running, and the patched-installer route was refused. **Owner unblock**: once no anvil is running, `aztec-up install 6.0.0-rc.1`, then `aztec-up use 5.2.0` to restore the default for other work. Recompiling also clears phase 1's 57-file artifact-load cascade.

## Unblocked

- **Toolchain.** With the owner's authorization I stopped 17 orphaned anvils and 12 orphaned 5.2.0 `aztec start --local-network` nodes. Their 13 zombie anvil children cleared with them. All were PPID 1, 19–41 h old, and every port-registry claim among them named a dead owner PID. `aztec-up install 6.0.0-rc.1` then succeeded, and `aztec-up use 5.2.0` restored the machine default. The v6 layout matches what `compile.sh` expects: `bin/aztec-nargo` and `node_modules/.bin/{aztec,bb}`.
- **Recompile.** `compile.sh` builds TokenBridgeHub class `0x210217f6…ad5c`, and `compile.sh --check` reproduces it. Neither artifact contains a local path.
- **TXE.** `run-txe-tests.sh` passes 65/65 with exit 0. A latent script bug surfaced first: the manifest check piped `sed | grep -q` under pipefail, and grep's early exit SIGPIPEs sed for matches near the top of a log larger than the pipe buffer, which v6's longer log is. Fixed with a here-string.
- **Re-pins.**
  - Token is `0x24c34002…1505` and Dripper is `0x1febf892…c5f9`, re-derived from the installed aztec-standards 6.0.0-rc.1.
  - The hub-token keystone moves to `0x09adfd69…18b9`; the Noir `nargo test keystone` and the TS leg agree independently.
  - The hub takes the Token class as a constructor argument, so no contract change was needed.
- **Mainnet manifest test**. `bridge-generation.test.ts` had held both shipped manifests to the global FPC pin. It now uses each network's own descriptor, and asserts that any network with a bridge names `PRIVATE_FPC_ADDRESS`. That assertion guards the risk recorded in phase 3.

`test:all` red set after phase 2 (4 files), all deployment or manifest re-derivations:
- The sandbox fixture `fixtures/sandbox-manifest.json`, whose hub address was derived from the old class. It regenerates from phase 4's sandbox deploy. Affected: `manifest-v2.fixture.test.ts`, `bridge-generation.test.ts` (2 sandbox tests) and `useTokenSelection.test.ts` (2).
- The live testnet files `testnet-bridge.json` and `deployments.json`, which phases 5–6 regenerate. Affected: `bridge-generation.test.ts` (testnet) and `deployments-records.test.ts`.

## Halmos (closes the gate's last open step)

This run used CI's exact pair, forge 1.7.1 and halmos 0.3.3. Both were fetched into a scratch directory (the forge release tarball and a Python venv); nothing was installed machine-wide. The build output and cache went to that directory, so the tree's `out/` stayed untouched. The commands match `_bridge-contracts.yml`: `forge build --ast --force`, then `halmos --match-contract '^Formal'`.

Result: **12/12 proofs pass**, exit 0. FormalClone 2/2, FormalFactory 2/2, FormalRouter 8/8, the last including the four `conservesUserFunds` proofs (207, 16, 180 and 16 paths).
