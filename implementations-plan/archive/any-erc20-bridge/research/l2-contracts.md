# Research: L2 contracts (`contracts/bridge/aztec`) + Wonderland `vault_deployer`

Snapshot: the base branch. Contracts pin `aztec-packages@v5.0.1`; aztec-standards `v5.0.1` (`token_bridge/Nargo.toml:7,11`, `token_minter_proxy/Nargo.toml:8`). The Wonderland reference (aztec-standards, `src/vault_deployer`) pins `v5.2.0`.

## `token_bridge` (`token_bridge/src/main.nr`, 159 lines)

Storage `:31-37`: `owner: PublicMutable<AztecAddress>`, `pending_owner`, `config: PublicImmutable<Config>` (`config.nr:9-13` = `{ token_minter_proxy: AztecAddress, portal: EthAddress }`), `is_paused: PublicMutable<bool>`.

Constructor `:39-46` `#[external("public")] #[initializer] fn constructor(token_minter_proxy, portal)` — **the L1 portal is a plain ctor arg**, so it is in the address preimage via `initialization_hash`. There is no protocol-level `portal_contract_address` in v5 (the only hits are function params in `aztec-nr/aztec/src/messaging.nr:11`).

| Fn | Domain | Notes |
|---|---|---|
| `claim_public(to, amount, secret, message_leaf_index)` `:94-103` | public | `get_mint_to_public_content_hash(to, amount)` + `consume_l1_to_l2_message(content, [secret], config.portal, leaf)` |
| `claim_private(recipient, amount, claim_salt, message_leaf_index)` `:114-134` | private | `secret = derive_claim_secret(claim_salt, recipient)` (F-007 recipient commitment) then consume with `get_mint_to_private_content_hash(amount)`; pause via `enqueue_self._assert_not_paused()` `:121` (private effects happen before the pause check reverts) |
| `exit_to_l1_public/private(recipient, amount, caller_on_l1, authwit_nonce)` `:137-158` | public/private | `get_withdraw_content_hash` + `context.message_portal(config.portal, content)` |
| ownership ×3, `set_paused`, `get_config(_public)`, `_assert_not_paused` `#[only_self]` | | |

Content hashes come from upstream `token_portal_content_hash_lib` (same lib the Solidity portal mirrors). `derive_claim_secret` in `claim_secret/src/lib.nr:26-31` = `poseidon2_hash_with_separator([salt, recipient], DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET=3140354885)`.

The bridge never touches the Token directly — only `TokenMinterProxy` (`:102,133,145,157`); `burn_*` pass `self.msg_sender()` so users authwit the **proxy** (`test/exits.nr:30-37`).

## `token_minter_proxy` (`token_minter_proxy/src/main.nr`, 97 lines)

"F-002: immutable single-minter" (README is stale about an allow-list). Storage = three `PublicImmutable`s `owner/token/bridge` `:17-22`; `set_token`/`set_bridge` owner-gated single-shot (`PublicImmutable::initialize` nullifier) `:30-44`; `mint_to_public`/`burn_public` inline `assert(bridge == msg_sender)` `:70-82`; private variants enqueue `assert_bridge` `:84-96`. After wiring the owner has zero authority. **Removable**: aztec-standards `Token` already enforces a single immutable minter.

## Token + deploy order (current)

Token = aztec-standards `Token` (`src/token_contract/src/main.nr`): `minter: PublicImmutable<AztecAddress>` `:60`; `constructor_with_minter(name, symbol, decimals, minter, auth_contract)` `:99-111`; `_validate_minter` `:419-431, 541-542` = `assert(minter.eq(sender), "caller is not minter")`.

`packages/bridge-core/scripts/deploy-bridge-testnet.ts:472-575`: L1 token (or `--reuse-token`) → the forked portal with `[]` ctor args `:501` → L2 proxy (`constructor`, []) → L2 token (`constructor_with_minter`, `[name, symbol, decimals, proxy, ZERO]`) → L2 bridge (`constructor`, `[proxy, EthAddress(portal)]`) `:530-554` → `wirePortal` `:251` (`set_token`, `set_bridge`, preflights, `portal.initialize(registry, usdc, bridge)`) → readbacks → candidate manifest.

All L2 deploys are **universal** (`deployer = AztecAddress.ZERO`): `packages/bridge-core/scripts/script-l2.ts:23-34 universalDeployInstance` (`getContractInstanceFromInstantiationParams(art, {constructorArgs, salt, publicKeys: PublicKeys.default(), deployer: ZERO, constructorArtifact})`). Salts `randomInt(2, 2**40)` per generation, journaled first. Gotcha `deploy-bridge-testnet.ts:229-233`: salt/universalDeploy are construction-time options, silently ignored on `.send()`.

The cycle today: portal deployed uninitialized (address independent of L2) → L2 bridge constructed with that portal → `portal.initialize(.., bridge)` bound after (deployer-only, once).

## Tests

- **TXE, 33 tests** in `token_bridge/src/test/{claims,claims_private,exits,proxy_guards,ownership}.nr`; harness `test/utils.nr:27-55 setup()` deploys the production trio via `env.deploy("@token_minter_proxy/TokenMinterProxy")`, `env.deploy("@token_contract/Token")`, `env.deploy("TokenBridge")` + `with_public_initializer`; L1→L2 messages injected with `env.send_l1_to_l2_message_from_secret_hash(content, secret_hash, PORTAL, bridge)` `:78-92` using the SAME content-hash lib. Every `should_fail` pins an exact string (a bare one is satisfied by a dead oracle — `proxy_guards.nr:61-63`).
- Runner `contracts/bridge/aztec/scripts/run-txe-tests.sh` (123 lines): stages dependency artifacts into `token_bridge/target/` as `<dep>-<Contract>.json` (transpiled `token_contract-Token.json` from `@aztec-foundation/aztec-standards`), picks a free port, `bun add @aztec/txe@5.0.1` in a cache dir, starts the server under **node** (lmdb crashes bun), `NARGO_FOREIGN_CALL_TIMEOUT=1200000`, `aztec-nargo test --force --test-threads 4 --oracle-resolver`, asserts a positive pass count. Gotchas: `implementations-plan/archive/bridge-hardening/lessons/txe-testing.md`.
- **Keystone** `keystone/src/main.nr`: 8 `nargo test`s (3 content-hash vectors ↔ Solidity literals, domain-separator pin, claim-secret vectors ↔ TS, 2 fuzz properties). CI `noir` job resolves the toolchain from `keystone/Nargo.toml`.
- `check-sole-consumer.sh` (static F-007 tripwire on `token_bridge/src/main.nr`): exactly 2 `consume_l1_to_l2_message` sites, `claim_private` takes `claim_salt` and calls `derive_claim_secret(`, dataflow check on the consume secret, bans `process_l1_to_l2_message|push_nullifier`, `--self-test`. **Must be re-pointed at the hub.**
- TS mirrors: `packages/bridge-core/src/noir-artifact-classids.test.ts` (class-id + sha256 pins: `TokenMinterProxy 0x07689a53…`, `TokenBridge 0x2cb5c634…`), `claim-secret.test.ts`, `content-hash.test.ts`, `l1.test.ts`; symmetry contract `implementations-plan/archive/bridge-hardening/txe-ts-map.md`.
- **TXE is NOT in CI** (`_bridge-contracts.yml:9-12`; owner scoped it out of this plan → stays a local per-phase gate).

## Wonderland `vault_deployer` — in-contract deployment mechanics (aztec-packages v5.2.0)

Design (`vault_deployer/src/main.nr:3-16`): a disposable per-deployment instance whose **private initializer** deploys children; README `:7`: `publish_contract_instance_for_public_execution` is private-only, so a reusable public factory is blocked until aztec-packages#20771.

Core `_publish_vault_and_shares_instances` `:111-160`:
```rust
let salt = get_contract_instance(self.address).salt;
let vault = _derive_instance(ctor.selector, hash_args(ctor.args), vault_class_id, salt, self.address);
let shares = _derive_instance(Token::interface().constructor_with_minter(name, symbol, decimals, vault, ZERO) …, shares_class_id, salt, self.address);
publish_contract_instance_for_public_execution(context, vault);
publish_contract_instance_for_public_execution(context, shares);
self.enqueue(Vault::at(vault).constructor(asset, vault_offset));
self.enqueue(Token::at(shares).constructor_with_minter(...));
```
`_derive_instance` = `ContractInstance { salt, deployer, original_contract_class_id, initialization_hash: compute_initialization_hash(selector, args_hash), immutables_hash: 0, public_keys: PublicKeys::default() }.to_address()`.

Three moves, no `deploy()` API:
1. **Derive** in-circuit: `ContractInstance::to_address()` (`noir-protocol-circuits/crates/types/src/contract_instance.nr:32-45`) = `AztecAddress::compute(public_keys, PartialAddress::compute(class_id, salt, init_hash, deployer, immutables_hash))`; `compute_initialization_hash(selector, args_hash) = poseidon2([selector, args_hash], DOM_SEP__INITIALIZER)` (`aztec-nr/aztec/src/macros/functions/initialization_utils.nr:178-183`).
2. **Publish**: `publish_contract_instance_for_public_execution(context: &mut PrivateContext, target)` (`aztec-nr/aztec/src/publish_contract_instance.nr:13-54`) reads the preimage from the PXE oracle `get_contract_instance(target)` (SDK must pre-register it), asserts `deployer.is_zero() || deployer == this_address` `:16-19`, calls `ContractInstanceRegistry::publish_for_public_execution(...)`. The registry (`noir-contracts/.../contract_instance_registry_contract/src/main.nr:99-183`) asserts the **class nullifier exists**, recomputes the address, **emits the address as a nullifier** (the AVM checks it before public execution), emits `ContractInstancePublished`.
3. **Initialize**: enqueue the child's public constructor; the macro guard `assert_initialization_matches_address_preimage_*` (`initialization_utils.nr:152-174`) asserts `init_hash == compute_initialization_hash(selector, args_hash)` and `deployer.is_zero() | deployer == msg_sender` → the enqueuing contract must be the recorded `deployer`.

Addresses are derivable off-chain (`src/ts/test/utils.ts:277-305`: compute child instances with `deployer: <deployer instance address>`, `registerContract` all, then deploy). One tx can publish + initialize + call the child (`main.nr:147-157, 63`). Class must be published once per network (`ensureVaultContractClassPublished`). Instances can later be upgraded via `ContractInstanceRegistry::update` (`main.nr:194-235`, `DelayedPublicMutable`, callable only by the instance itself; address never changes).

## Implications for the hub design

- Portal binding is app storage, message `sender`/`recipient` are parameters → a hub can serve every portal.
- Hub-as-deployer of per-token Tokens: derive `{salt: H(erc20), deployer: HUB, class: TOKEN_CLASS, init_hash: H(constructor_with_minter(name, symbol, decimals, HUB, ZERO))}` in-circuit, publish (private), enqueue ctor (public, `msg_sender == HUB`). The token address is a pure function of `(erc20, name, symbol, decimals)` → the erc20↔token binding is proven by derivation, no trusted registrar.
- `register_token` must therefore be a **private** entrypoint (publish is private-only) whose enqueued public part consumes the L1 `register` message (portal derived via keccak/CREATE2 in the AVM) and writes `portal_of[token]`.
- Private first claim on a brand-new token needs the token's `minter` in historical public state → **2 txs** once per token (register, then claim). Public claims batch register + claim in one tx.
- Genesis cycle (hub needs `l1_factory`; factory needs `HUB`): hub ctor takes no L1 args; one-shot deployer-only `bind_l1(l1_factory, portal_init_code_hash)`.
- Drop `TokenMinterProxy`; hub = minter. `check-sole-consumer.sh` + class-id pins + `txe-ts-map.md` re-pointed.
- Open API questions handed to the feasibility check: keccak256 in AVM/private cost, `Map<AztecAddress, PublicImmutable<EthAddress>>` support, 5.2.0 signatures.
