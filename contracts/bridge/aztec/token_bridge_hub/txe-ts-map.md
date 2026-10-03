# TokenBridgeHub — what each TXE test proves, and where the other side of the bridge pins it

The hub's TXE suite (`src/test/*.nr`, 65 named tests in `txe-manifest.txt`) runs the real contract
against injected L1→L2 messages. Every property that crosses the L1↔L2 boundary has a counterpart on
the L1 side (`contracts/bridge/evm/test`) or in `packages/bridge-core`; this map is how a reviewer
checks that a property is pinned on BOTH ends, not asserted on one and assumed on the other.

The TXE cannot run the protocol class-registry path (`publish_contract_instance_for_public_execution`),
so tests pre-register each Token instance through the raw deploy oracle and drive the publish-free
`bind_*` entrypoints. Those consume with a HARNESS secret a real factory never commits to
(`bind_cannot_consume_a_real_factory_leaf`); `register_*` consume with the factory secret and then
publish — `register_*_reaches_the_publish` pin that both wrappers get as far as the publish's
class-nullifier read, and the sandbox smoke is the gate for the publish itself.
There is no outgoing-message oracle either: exits assert the burn, and the withdraw content is pinned
by the keystone crate + `ContentHash.t.sol`.

| Property | TXE (`src/test/`) | L1 / TS counterpart |
|---|---|---|
| The register message is `sha256ToField(register(token, portal, nameWord, symbolWord, decimals))` with secret `compute_secret_hash([0])` | `keystone.nr` (address vector), `register.nr::register_and_claim_public_in_one_tx` | `Keystone.t.sol`, `register-hash.test.ts`, keystone crate `register_matches_l1_and_ts` / `register_secret_hash_is_pinned` |
| Only the factory's messages register (sender-keyed) | `register_from_foreign_sender_rejected` | `BlackhatFactory` F-1 (front-run yields the identical factory-sent message); `PortalFactoryInvariant` I4 (one register per portal) |
| The portal inside the content is the one bound | `register_with_swapped_portal_rejected`, `two_tokens_register_independently` | `PortalFactory.t.sol` tuple test (`portal == predictPortal`, event/registration/message agree); `FormalFactory` `check_predictPortal_isCreate2OfInitcode` |
| Wrong or swapped metadata fails in the private phase with no side effects (a correct retry afterwards is observable only in the sandbox smoke — a failed TXE call aborts the test) | `wrong_metadata_fails_before_any_side_effect`, `register_with_wrong_name_word_rejected`, `register_with_swapped_words_rejected` | `BlackhatFactory` F-4 (metadata frozen at creation) |
| One registration per ERC-20, first wins (both the `token_of` and the `portal_of` branch); leaves cannot be replayed | `register_replay_of_same_leaf_rejected`, `second_factory_leaf_for_same_erc20_rejected`, `second_factory_leaf_with_same_words_different_portal_rejected`, `register_and_claim_for_registered_token_rejected` | `createPortal` idempotence (`PortalFactory.t.sol`, `PortalFactoryInvariant` I1) |
| Anyone may register; the depositor's claim is unaffected (relayer-first) | `relayer_registers_then_depositor_claims` | `BlackhatFactory` F-1 |
| One-tx public first claim; two-tx private first claim | `register_and_claim_public_in_one_tx`, `claim_private_after_registration` | `hub-token.test.ts` (the app derives the same Token address to register with the PXE) |
| Registration + a public claim in one transaction: the enqueued ctor precedes the mint | `register_and_claim_public_in_one_tx` | — (L2-only ordering) |
| Discovery never reverts | `discovery_reads_zero_for_unregistered` | `factory-abi.ts` `portalOf`/`tokenOf` (zero when unregistered) |
| Every u8 decimals registers | `decimals_extremes_register` | `PortalFactory.t.sol` decimals 0/18/19/38/255 |
| A deposit through portal A mints only token A (public + private) | `claims.nr::claim_public_message_from_portal_a_cannot_mint_token_b`, `claims_private.nr::…_token_b` | `CloneRoundtripFuzz` (the clone is the message sender; the hub is the L2 actor) |
| Public claim content binds recipient + amount; secret must match; no replay | `claim_public_wrong_recipient_rejected`, `…_wrong_amount_…`, `…_wrong_secret_…`, `claim_public_replay_rejected` | `ContentHash.t.sol` `mint_to_public` vector; `PortalRoundtripFuzz` / `CloneRoundtripFuzz` |
| Private claim cannot be redirected (F-007); secret derived from the recipient | `claim_private_redirect_to_another_recipient_rejected`, `claim_private_wrong_salt_rejected`, `claim_private_by_relayer_credits_the_recipient` | `claim-secret.ts` + keystone crate `derive_claim_secret` vectors; `check-sole-consumer.sh` (3 named consume sites) |
| Unregistered token: claims and exits die on the uninitialized portal slot (both domains) | `claim_public_unregistered_token_reverts`, `claim_private_unregistered_token_reverts`, `exit_*_unregistered_token_reverts` | `SwapBridgeRouter` refuses a foreign/unbound portal before any pull (`check_bridge_rejectsForeignPortal`) |
| Exits burn exactly the exited amount of THAT token, via an authwit to the hub — the burn precedes the withdraw message, so a message can never outlive a failed burn | `exits.nr::exit_public_burns_the_caller_balance`, `exit_private_burns_the_private_balance` | `TokenPortalImpl.withdraw` exact debit (`PortalFactory.t.sol`, `FormalClone`) |
| An authwit for token A is useless against token B (consumer = Token) | `exit_public_authwit_for_token_a_replayed_against_token_b_rejected`, `exit_private_…` | — (L2-only) |
| Over-exit dies on the burn, never emitting a withdraw for undestroyed value | `exit_public_insufficient_balance_rejected`, `exit_private_insufficient_balance_rejected` | `withdraw` consumes the Outbox message before paying (`TokenPortalImpl`) |
| Zero amount rejected on both claims and both exits; zero recipient rejected on the private claim and both exits | `exit_*_zero_*_rejected`, `claim_public_zero_amount_rejected`, `claim_private_zero_*_rejected` | `AmountExceedsL2Max` / `InexactTransfer` guards on L1 (`PortalFactory.t.sol`) |
| `_register` / `_assert_exits_open` are only-self | `guards.nr` | — |
| Guardian-only exit pause; claims + registration unaffected; unpause restores; `exits_paused()` view tracks the switch | `pause.nr` | `PortalFactory.setPaused` (`FormalFactory` `check_setPaused_revertsForNonOwner`, `FormalClone` pause proofs, `PortalFactoryInvariant` I3/I3b) |
| The in-circuit Token address equals bridge-core's derivation | `keystone_hub_token_address_matches_bridge_core`, `keystone_oversized_word_is_rejected` | `hub-token.test.ts`; `noir-artifact-classids.test.ts` (Token + hub class ids) |
