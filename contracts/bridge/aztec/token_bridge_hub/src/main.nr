mod test;

// One hub serves every bridged ERC-20. An L1 PortalFactory creates a storage-less portal clone per
// token and sends a `register` message (the FACTORY is the L1 sender; the portal address travels in
// the content) that this contract consumes to learn the token's portal and to create the L2 token
// itself: the aztec-standards Token instance is derived in-circuit from the attested words with this
// hub as deployer and minter, so no party can pair a foreign portal or token with a real one.

use aztec::macros::aztec;

#[aztec]
pub contract TokenBridgeHub {
    use aztec::{
        hash::hash_args,
        macros::{
            functions::{
                external, initialization_utils::compute_initialization_hash, initializer, internal,
                only_self, view,
            },
            storage::storage,
        },
        protocol::{
            address::{AztecAddress, EthAddress}, contract_class_id::ContractClassId,
            contract_instance::ContractInstance, public_keys::PublicKeys, traits::ToField,
        },
        publish_contract_instance::publish_contract_instance_for_public_execution,
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use claim_secret_lib::derive_claim_secret;
    use compressed_string::FieldCompressedString;
    use register_hash_lib::{BIND_HARNESS_SECRET, get_register_content_hash, REGISTER_SECRET};
    use token::Token;
    use token_portal_content_hash_lib::{
        get_mint_to_private_content_hash, get_mint_to_public_content_hash,
        get_withdraw_content_hash,
    };

    #[storage]
    struct Storage<Context> {
        l1_factory: PublicImmutable<EthAddress, Context>,
        token_class_id: PublicImmutable<ContractClassId, Context>,
        guardian: PublicImmutable<AztecAddress, Context>,
        exits_paused: PublicMutable<bool, Context>,
        portal_of: Map<AztecAddress, PublicImmutable<EthAddress, Context>, Context>,
        token_of: Map<EthAddress, PublicImmutable<AztecAddress, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(token_class_id: ContractClassId, l1_factory: EthAddress, guardian: AztecAddress) {
        self.storage.token_class_id.initialize(token_class_id);
        self.storage.l1_factory.initialize(l1_factory);
        self.storage.guardian.initialize(guardian);
        self.storage.exits_paused.write(false);
    }

    // The guardian's only power. Claims are never pausable: a deposit already made must always be
    // claimable, and an exit that has not burned yet can simply wait.
    #[external("public")]
    fn set_exits_paused(paused: bool) {
        assert(self.storage.guardian.read() == self.msg_sender(), "not guardian");
        self.storage.exits_paused.write(paused);
    }

    #[external("public")]
    #[only_self]
    fn _assert_exits_open() {
        assert(!self.storage.exits_paused.read(), "exits paused");
    }

    #[external("public")]
    #[view]
    fn exits_paused() -> bool {
        self.storage.exits_paused.read()
    }

    // ── Registration ───────────────────────────────────────────────────────────────────────

    // Publishes the derived Token instance, then binds it. Only this hub can publish an instance whose
    // deployer is this hub, so this is the entrypoint every real caller uses.
    #[external("private")]
    fn register_token(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
    ) {
        let _ = self.internal._bind(
            erc20,
            portal,
            name_word,
            symbol_word,
            decimals,
            register_leaf_index,
            true,
        );
    }

    // Registration + a public claim in one transaction: the enqueued calls run in order (ctor,
    // `_register`, then `claim_public`), and a public mint sees the constructor's live state.
    #[external("private")]
    fn register_and_claim_public(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
        to: AztecAddress,
        amount: u128,
        secret: Field,
        claim_leaf_index: Field,
    ) {
        let token = self.internal._bind(
            erc20,
            portal,
            name_word,
            symbol_word,
            decimals,
            register_leaf_index,
            true,
        );
        self.enqueue_self.claim_public(token, to, amount, secret, claim_leaf_index);
    }

    // Publish-free variants for a harness that pre-registers the instance (the TXE cannot execute
    // the class-registry path). They consume with a DIFFERENT secret than the factory commits to, so
    // on a real network no factory leaf can be spent through them — a caller who skipped the publish
    // would otherwise bind a Token nothing can construct and burn the token's one-shot leaf.
    #[external("private")]
    fn bind_token(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
    ) {
        let _ = self.internal._bind(
            erc20,
            portal,
            name_word,
            symbol_word,
            decimals,
            register_leaf_index,
            false,
        );
    }

    #[external("private")]
    fn bind_and_claim_public(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
        to: AztecAddress,
        amount: u128,
        secret: Field,
        claim_leaf_index: Field,
    ) {
        let token = self.internal._bind(
            erc20,
            portal,
            name_word,
            symbol_word,
            decimals,
            register_leaf_index,
            false,
        );
        self.enqueue_self.claim_public(token, to, amount, secret, claim_leaf_index);
    }

    // The register message is consumed BEFORE anything is published or enqueued, so a wrong-metadata
    // or already-consumed attempt fails with no side effects: a stranded publish nullifier would make
    // that token unregisterable forever (the registry emits the address as a nullifier).
    #[internal("private")]
    fn _bind(
        erc20: EthAddress,
        portal: EthAddress,
        name_word: Field,
        symbol_word: Field,
        decimals: u8,
        register_leaf_index: Field,
        publish: bool,
    ) -> AztecAddress {
        let l1_factory = self.storage.l1_factory.read();
        let content = get_register_content_hash(erc20, portal, name_word, symbol_word, decimals);
        let secret = if publish { REGISTER_SECRET } else { BIND_HARNESS_SECRET };
        self.context.consume_l1_to_l2_message(content, [secret], l1_factory, register_leaf_index);

        let name = word_to_str(name_word);
        let symbol = word_to_str(symbol_word);
        let hub = self.context.this_address();
        let token = derive_token(
            hub,
            self.storage.token_class_id.read(),
            erc20,
            name,
            symbol,
            decimals,
        );

        if publish {
            publish_contract_instance_for_public_execution(self.context, token);
        }
        self.enqueue(Token::at(token).constructor_with_minter(
            name,
            symbol,
            decimals,
            hub,
            AztecAddress::zero(),
        ));
        self.enqueue_self._register(erc20, portal, token);
        token
    }

    // First registration wins: both PublicImmutables refuse a second initialize, so a second
    // factory-authored leaf for the same ERC-20 (a hypothetical — createPortal is idempotent) cannot
    // re-point an existing token.
    #[external("public")]
    #[only_self]
    fn _register(erc20: EthAddress, portal: EthAddress, token: AztecAddress) {
        self.storage.portal_of.at(token).initialize(portal);
        self.storage.token_of.at(erc20).initialize(token);
    }

    // ── Claims ─────────────────────────────────────────────────────────────────────────────

    #[external("public")]
    fn claim_public(
        token: AztecAddress,
        to: AztecAddress,
        amount: u128,
        secret: Field,
        message_leaf_index: Field,
    ) {
        assert(amount > 0, "Amount must be greater than zero");
        let portal = self.storage.portal_of.at(token).read();
        let content_hash = get_mint_to_public_content_hash(to, amount);
        self.context.consume_l1_to_l2_message(content_hash, [secret], portal, message_leaf_index);
        self.call(Token::at(token).mint_to_public(to, amount));
    }

    // The private content hash omits the recipient; the consumption secret is DERIVED from the
    // recipient in-circuit (`derive_claim_secret(claim_salt, recipient)`), so a relayer can submit the
    // claim without being able to redirect it. INVARIANT: the only consumer of a `mint_to_private`
    // message — an entrypoint taking a raw secret would make the claim a bearer instrument again.
    // Guarded by scripts/check-sole-consumer.sh.
    #[external("private")]
    fn claim_private(
        token: AztecAddress,
        recipient: AztecAddress,
        amount: u128,
        claim_salt: Field,
        message_leaf_index: Field,
    ) {
        assert(amount > 0, "Amount must be greater than zero");
        assert(!recipient.is_zero(), "Recipient cannot be zero");
        let portal = self.storage.portal_of.at(token).read();
        let content_hash = get_mint_to_private_content_hash(amount);
        let secret = derive_claim_secret(claim_salt, recipient);
        self.context.consume_l1_to_l2_message(
            content_hash,
            [secret],
            portal,
            message_leaf_index,
        );
        self.call(Token::at(token).mint_to_private(recipient, amount));
    }

    // ── Exits ──────────────────────────────────────────────────────────────────────────────

    #[external("public")]
    fn exit_to_l1_public(
        token: AztecAddress,
        recipient: EthAddress,
        amount: u128,
        caller_on_l1: EthAddress,
        authwit_nonce: Field,
    ) {
        assert(!self.storage.exits_paused.read(), "exits paused");
        assert(amount > 0, "Amount must be greater than zero");
        assert(!recipient.is_zero(), "Recipient cannot be zero");
        let portal = self.storage.portal_of.at(token).read();
        self.call(Token::at(token).burn_public(self.msg_sender(), amount, authwit_nonce));
        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(portal, content);
    }

    #[external("private")]
    fn exit_to_l1_private(
        token: AztecAddress,
        recipient: EthAddress,
        amount: u128,
        caller_on_l1: EthAddress,
        authwit_nonce: Field,
    ) {
        self.enqueue_self._assert_exits_open();
        assert(amount > 0, "Amount must be greater than zero");
        assert(!recipient.is_zero(), "Recipient cannot be zero");
        let portal = self.storage.portal_of.at(token).read();
        self.call(Token::at(token).burn_private(self.msg_sender(), amount, authwit_nonce));
        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);
        self.context.message_portal(portal, content);
    }

    // ── Discovery ──────────────────────────────────────────────────────────────────────────

    // Zero when unregistered — discovery must not revert. Claims and exits use the hard-reverting read.
    #[external("public")]
    #[view]
    fn token_for(erc20: EthAddress) -> AztecAddress {
        let slot = self.storage.token_of.at(erc20);
        if slot.is_initialized() {
            slot.read()
        } else {
            AztecAddress::zero()
        }
    }

    #[external("public")]
    #[view]
    fn portal_for(token: AztecAddress) -> EthAddress {
        let slot = self.storage.portal_of.at(token);
        if slot.is_initialized() {
            slot.read()
        } else {
            EthAddress::zero()
        }
    }

    // ── Library ────────────────────────────────────────────────────────────────────────────

    // The L1 word is the only datum shared by event, message, manifest and journal. `to_bytes` is a
    // 31-limb decomposition, so a word wider than 31 bytes cannot reach the constructor hash at all.
    #[contract_library_method]
    pub fn word_to_str(word: Field) -> str<31> {
        FieldCompressedString::from_field(word).to_bytes().as_str_unchecked()
    }

    // The token address is a pure function of (hub, class, erc20, attested metadata). Derived from the
    // typed, re-serialized constructor args — never from a caller-supplied args hash.
    #[contract_library_method]
    pub fn derive_token(
        hub: AztecAddress,
        token_class_id: ContractClassId,
        erc20: EthAddress,
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
    ) -> AztecAddress {
        let call = Token::interface().constructor_with_minter(
            name,
            symbol,
            decimals,
            hub,
            AztecAddress::zero(),
        );
        let initialization_hash = compute_initialization_hash(call.selector, hash_args(call.args));
        ContractInstance {
            salt: erc20.to_field(),
            deployer: hub,
            original_contract_class_id: token_class_id,
            initialization_hash,
            immutables_hash: 0,
            public_keys: PublicKeys::default(),
        }
            .to_address()
    }
}
