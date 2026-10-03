# Phase 0 — spike + keystones

A spike branch (never merges); the keystone tests + the hub crate are cherry-picked into Arcs 1–2.

## Verdicts

- **TXE in-contract deploy — Verdict B, by source, not by trial.** The TXE `deploy` cheatcode (`yarn-project/txe/src/oracle/txe_oracle_top_level_context.ts:271-303`) mines the instance nullifier directly and never registers a *class* nullifier; the protocol `ContractInstanceRegistry.publish_for_public_execution` asserts the class nullifier exists, so the hub's `publish_contract_instance_for_public_execution` can never succeed under TXE. Harness shape (D17): the raw `txe_oracles::deploy(path, "constructor_with_minter", args, 0, salt = erc20, deployer = hub)` registers the instance with the real init-hash and deployer **without** calling the constructor; the hub's publish-free `bind_token` / `bind_and_claim_public` then consume the message, derive the address, enqueue the constructor (`msg_sender == hub == deployer` — the guard passes) and `_register`. Production callers use `register_token` / `register_and_claim_public` (= publish + the same body). The only line TXE cannot exercise is the aztec-nr library call itself; the sandbox smoke (P6) is its gate.
- **D11 — one-tx public first claim: proven in TXE.** `bind_and_claim_public` in a single `call_private`: constructor → `_register` → `claim_public` → `mint_to_public`, balance observed. The 2-tx private first claim works as designed (`claim_private_after_registration`).
- **D36 — private-phase consume: proven.** A wrong-`decimals` bind fails with `No L1 to L2 message found` and leaves nothing behind; the correct bind for the same token succeeds afterwards.
- **D21 — compressed-word args: compiles and round-trips on 5.0.1.** `FieldCompressedString::from_field(w).to_bytes().as_str_unchecked()` + `from_string(s).is_eq(from_field(w))`. An oversized word fails even earlier, inside `to_be_bytes::<31>` ("Field failed to decompose into specified 31 limbs") — pinned as the negative keystone.
- **D39 — `aztec-nargo compile` is NOT enough**: the TXE rejected the plain-nargo artifact ("public bytecode has not been transpiled"). `aztec compile` (5.0.1 CLI + `bb`) produces the deployable, transpiled artifact. CI parity (P3) must use that path.
- **D35 — address keystone without TXE**: `derive_token` / `word_to_str` are `pub` `contract_library_method`s; `aztec-nargo test keystone` in the hub crate pins the fixed vector with no oracle.

## Keystone vectors (all three toolchains agree)

| Vector | Value |
|---|---|
| `nameWord` of the test name | the test name word |
| `symbolWord` of the test symbol | the test symbol word |
| `REGISTER_SECRET_HASH = compute_secret_hash([0])` | `0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250` |
| `registerHash(0xe2c20, 0x9017a1, words, 18)` | `0x000d08f46744da94f56ca7a8fcc0b131ca3b48456b03083d107728d8530397a7` |
| `register(address,address,bytes32,bytes32,uint8)` selector | `0xfbc7d0f1` (codex's Round-1 `0x7793ce54` was hallucinated — `cast sig` is the authority) |
| `predictPortal(0x33…, 0x11…, 0x22…)` | `0x9E4fc5082E41ec39a0d4a8b624A3baf3289c5Eee` |
| hub token (`hub 0x1234…0abc`, class `0x0225da0f…`, erc20 `0xe2c20`, words, 18) | `0x16d03942b8ae31464284482ee43727e40718773358bf324c5c287f52a63b573d` |

Legs: `contracts/bridge/evm/test/Keystone.t.sol` · `contracts/bridge/aztec/keystone/src/main.nr` (+ `register_hash_lib`) · `contracts/bridge/aztec/token_bridge_hub/src/test/keystone.nr` · `packages/bridge-core/src/{register-hash,portal-address,hub-token}.test.ts`.

## Tooling notes

- `run-txe-tests.sh --crate <dir>` (allowlist), per-crate `txe-manifest.txt` (named tests; ANSI-stripped match), server deps from `contracts/bridge/aztec/txe-server/{package.json,bun.lock}` with `--frozen-lockfile` (D24). Blocked postinstalls (`bcrypto`, `protobufjs`, `@parcel/watcher`, `unrs-resolver`) are the same set the old cache-dir install had; lmdb ships prebuilt.
- `scripts/nargo-5.sh <crate> <args>` pins the 5.0.1 nargo for every local invocation.
- Library methods inside `#[aztec]` contracts are module-private; tests reach them only if `pub`.
- `self.context` is already `&mut PrivateContext` in the macro's self-shape — pass it as-is to `publish_contract_instance_for_public_execution`.
- Pre-existing biome noise on the base branch (29 warnings / 13 infos) is not ours; only error-level diagnostics gate.

## Gate (P0) — PASS

`bun run lint` ✓ · `bun run typecheck:all` ✓ · `bun run --cwd packages/bridge-core test` 37 files / 294 ✓ · `forge test --match-contract Keystone` 4/4 ✓ · `nargo-5.sh keystone test` 10/10 ✓ · `run-txe-tests.sh --crate token_bridge_hub` 6/6 + manifest ✓.
