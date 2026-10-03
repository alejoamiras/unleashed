// TXE harness for the hub. The TXE cannot execute the protocol class-registry path the hub's
// `register_token` takes to publish a Token instance (it never mines class nullifiers), so tests
// pre-register the instance through the raw deploy oracle — same salt, same initializer args, same
// `deployer = hub`, constructor NOT called — and drive the publish-free `bind_*` entrypoints. The
// hub's own enqueued constructor then initializes the token exactly as in production.

use crate::TokenBridgeHub;
use aztec::{
    hash::compute_secret_hash,
    protocol::{
        address::{AztecAddress, EthAddress}, contract_class_id::ContractClassId,
        contract_instance::ContractInstance, traits::ToField, utils::field::field_from_bytes,
    },
    test::helpers::{test_environment::TestEnvironment, txe_oracles},
};
use claim_secret_lib::derive_claim_secret;
use register_hash_lib::{BIND_HARNESS_SECRET, get_register_content_hash};
use token::Token;
use token_portal_content_hash_lib::{
    get_mint_to_private_content_hash, get_mint_to_public_content_hash,
};

/// The L1 factory identity the hub binds at construction — the only sender whose `register`
/// messages it consumes.
pub global FACTORY: EthAddress = EthAddress::from_field(0xFAC7);

pub struct Hub {
    pub env: TestEnvironment,
    pub admin: AztecAddress,
    pub guardian: AztecAddress,
    pub hub: AztecAddress,
    pub token_class_id: ContractClassId,
}

/// The L1 word for a 31-char string: `0x00 ‖ b0..b30` as a big-endian field, exactly what
/// PortalFactory.sol commits and what `FieldCompressedString` stores.
pub unconstrained fn word(s: str<31>) -> Field {
    field_from_bytes(s.as_bytes(), true)
}

/// Deploys the hub. The Token class id is read off a throwaway instance registration because the
/// TXE derives it from the artifact it serves — there is no other source in a Noir test.
pub unconstrained fn setup() -> Hub {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let guardian = env.create_light_account();

    let probe = txe_oracles::deploy(
        "@token_contract/Token",
        "constructor_with_minter",
        Token::interface()
            .constructor_with_minter(
                "probe00000000000000000000000000",
                "PRB0000000000000000000000000000",
                0,
                AztecAddress::zero(),
                AztecAddress::zero(),
            )
            .args,
        0,
        0x50726f6265,
        AztecAddress::zero(),
    );
    let token_class_id = probe.original_contract_class_id;

    let hub_init = TokenBridgeHub::interface().constructor(token_class_id, FACTORY, guardian);
    let hub = env.deploy("TokenBridgeHub").with_public_initializer(admin, hub_init);

    Hub { env, admin, guardian, hub, token_class_id }
}

/// Registers the Token instance the hub will derive for `erc20` (deployer = hub, salt = erc20,
/// constructor NOT called) and returns its address.
pub unconstrained fn pre_register_token(
    h: Hub,
    erc20: EthAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
) -> AztecAddress {
    let instance: ContractInstance = txe_oracles::deploy(
        "@token_contract/Token",
        "constructor_with_minter",
        Token::interface()
            .constructor_with_minter(name, symbol, decimals, h.hub, AztecAddress::zero())
            .args,
        0,
        erc20.to_field(),
        h.hub,
    );
    instance.to_address()
}

/// Injects a `register` message committed to the HARNESS secret — the only kind the publish-free
/// `bind_*` entrypoints consume. A real factory commits to `REGISTER_SECRET`, which they cannot.
pub unconstrained fn send_register_message(
    h: Hub,
    erc20: EthAddress,
    portal: EthAddress,
    name_word: Field,
    symbol_word: Field,
    decimals: u8,
) -> Field {
    let content = get_register_content_hash(erc20, portal, name_word, symbol_word, decimals);
    h.env.send_l1_to_l2_message_from_secret_hash(
        content,
        compute_secret_hash([BIND_HARNESS_SECRET]),
        FACTORY,
        h.hub,
    )
}

/// Injects a message exactly as the REAL factory commits it (secret 0) — which the harness
/// entrypoints must refuse.
pub unconstrained fn send_factory_register_message(
    h: Hub,
    erc20: EthAddress,
    portal: EthAddress,
    name_word: Field,
    symbol_word: Field,
    decimals: u8,
) -> Field {
    let content = get_register_content_hash(erc20, portal, name_word, symbol_word, decimals);
    h.env.send_l1_to_l2_message_from_secret_hash(
        content,
        register_hash_lib::register_secret_hash(),
        FACTORY,
        h.hub,
    )
}

pub unconstrained fn send_mint_to_public_message(
    h: Hub,
    portal: EthAddress,
    to: AztecAddress,
    amount: u128,
    secret: Field,
) -> Field {
    let content = get_mint_to_public_content_hash(to, amount);
    h.env.send_l1_to_l2_message_from_secret_hash(
        content,
        compute_secret_hash([secret]),
        portal,
        h.hub,
    )
}

/// Injects a portal's `mint_to_private` deposit message whose secret commits to `recipient`.
pub unconstrained fn send_mint_to_private_message(
    h: Hub,
    portal: EthAddress,
    recipient: AztecAddress,
    amount: u128,
    claim_salt: Field,
) -> Field {
    let content = get_mint_to_private_content_hash(amount);
    let secret_hash = compute_secret_hash([derive_claim_secret(claim_salt, recipient)]);
    h.env.send_l1_to_l2_message_from_secret_hash(content, secret_hash, portal, h.hub)
}

// ── Two-token fixtures ─────────────────────────────────────────────────────────────────────

pub global ERC20_A: EthAddress = EthAddress::from_field(0xE2C20A);
pub global PORTAL_A: EthAddress = EthAddress::from_field(0x9017A1A);
pub global NAME_A: str<31> = "Token Alpha00000000000000000000";
pub global SYMBOL_A: str<31> = "ALP0000000000000000000000000000";
pub global ERC20_B: EthAddress = EthAddress::from_field(0xE2C20B);
pub global PORTAL_B: EthAddress = EthAddress::from_field(0x9017A1B);
pub global NAME_B: str<31> = "Token Beta000000000000000000000";
pub global SYMBOL_B: str<31> = "BET0000000000000000000000000000";
pub global DECIMALS: u8 = 18;
pub global NONCE: Field = 7;
pub global L1_RECIPIENT: EthAddress = EthAddress::from_field(0xBEEF);

pub unconstrained fn send_register_message_from(
    h: Hub,
    sender: EthAddress,
    erc20: EthAddress,
    portal: EthAddress,
    name_word: Field,
    symbol_word: Field,
    decimals: u8,
) -> Field {
    let content = get_register_content_hash(erc20, portal, name_word, symbol_word, decimals);
    h.env.send_l1_to_l2_message_from_secret_hash(
        content,
        compute_secret_hash([BIND_HARNESS_SECRET]),
        sender,
        h.hub,
    )
}

pub unconstrained fn register(
    h: Hub,
    erc20: EthAddress,
    portal: EthAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
) -> AztecAddress {
    let token = pre_register_token(h, erc20, name, symbol, decimals);
    let (name_word, symbol_word) = (word(name), word(symbol));
    let leaf = send_register_message(h, erc20, portal, name_word, symbol_word, decimals);
    h.env.call_private(
        h.admin,
        crate::TokenBridgeHub::at(h.hub).bind_token(erc20, portal, name_word, symbol_word, decimals, leaf),
    );
    token
}

pub unconstrained fn register_a(h: Hub) -> AztecAddress {
    register(h, ERC20_A, PORTAL_A, NAME_A, SYMBOL_A, DECIMALS)
}

pub unconstrained fn register_b(h: Hub) -> AztecAddress {
    register(h, ERC20_B, PORTAL_B, NAME_B, SYMBOL_B, DECIMALS)
}

pub unconstrained fn fund_public(h: Hub, token: AztecAddress, portal: EthAddress, to: AztecAddress, amount: u128, secret: Field) {
    let leaf = send_mint_to_public_message(h, portal, to, amount, secret);
    h.env.call_public(to, crate::TokenBridgeHub::at(h.hub).claim_public(token, to, amount, secret, leaf));
}

pub unconstrained fn fund_private(
    h: Hub,
    token: AztecAddress,
    portal: EthAddress,
    recipient: AztecAddress,
    amount: u128,
    salt: Field,
) {
    let leaf = send_mint_to_private_message(h, portal, recipient, amount, salt);
    h.env.call_private(
        recipient,
        crate::TokenBridgeHub::at(h.hub).claim_private(token, recipient, amount, salt, leaf),
    );
}
