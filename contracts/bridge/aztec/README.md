# Bridge L2 contracts (Noir)

L2 contracts for the Unleashed any-ERC-20 bridge: `token_bridge_hub` — one hub per generation, bound
at construction to `[token_class_id, l1_factory, guardian]`. It consumes the factory's `register`
message (sender-keyed to the factory, the portal inside the content), derives and publishes the
token's L2 `Token` (aztec-standards, `deployer = hub`, `salt = erc20`, minter = hub), claims into
it (`claim_public` / `claim_private` — the latter recipient-committed) and exits back to Ethereum
(`exit_to_l1_public` / `exit_to_l1_private`, burn before the withdraw message). The guardian can
pause exits only. `bind_token` / `bind_and_claim_public` are the publish-free twins the TXE drives;
on a real network no factory leaf can be spent through them (pinned). `claim_secret` and `register_hash` are the shared derivation libraries; `keystone`
pins them against their TypeScript and Solidity mirrors.

## Toolchain — the pinned 6.0.0-rc.1 nargo

The crates pin aztec-nr and `compressed_string` (`aztec-labs-eng/aztec-nr`) and the standards `token`
(`AztecProtocol/aztec-standards`) at the `v6.0.0-rc.1` tags, the same line the JS packages, the
sandbox and the live testnet run. Every manifest names aztec-nr by the identical URL, with no
trailing slash: a different spelling makes Nargo build a second `aztec` crate. The content-hash
library is vendored at `token_portal_content_hash_lib/` (its header names the upstream commit and
digest) and consumed by path. A mismatched toolchain fails with a flood of macro errors
(`cannot find self`, `Could not resolve 'at'`). Always compile via `scripts/compile.sh`, which
selects it:

```bash
scripts/compile.sh            # AZTEC_HOME defaults to ~/.aztec/versions/6.0.0-rc.1 (aztec-up install 6.0.0-rc.1 first)
scripts/compile.sh --check    # CI: the class id derived from a rebuild must equal the committed one
```

The committed `token_bridge_hub/target/*.json` is a build input for `@unleashed/bridge-core`
(`src/artifacts.ts`) and the deploy scripts; a class-id shift there is a new generation, never a
re-pin of the live hub.

## Tests

- **TXE**: `scripts/run-txe-tests.sh` runs the 65 named tests in `token_bridge_hub/txe-manifest.txt`
  against a TXE server whose dependencies are the committed mini-project `txe-server/` (frozen
  lockfile — never an ad-hoc `bun add`). `token_bridge_hub/txe-ts-map.md` maps every cross-boundary
  property to its L1 / TS counterpart. The TXE cannot run the protocol registry publish
  (`publish_contract_instance_for_public_execution`) — the sandbox smoke is that gate.
- **Sole-consumer invariant** (three named consume sites; `claim_private` derives its secret)
  enforced statically by `scripts/check-sole-consumer.sh`.
- **Keystone** content-hash / register-hash / claim-secret equality (Solidity ↔ Noir ↔ TS) pinned in
  `contracts/bridge/evm/test/Keystone.t.sol` + `packages/bridge-core/src/{register-hash,claim-secret,l1}.test.ts`.
