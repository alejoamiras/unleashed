use crate::test::utils::{
    DECIMALS, ERC20_A, ERC20_B, NAME_A, NAME_B, PORTAL_A, PORTAL_B, pre_register_token, register,
    register_a, send_factory_register_message, send_mint_to_private_message,
    send_mint_to_public_message, send_register_message, send_register_message_from, setup,
    SYMBOL_A, SYMBOL_B, word,
};
use crate::TokenBridgeHub;
use aztec::protocol::{address::{AztecAddress, EthAddress}, traits::FromField};
use token::Token;

global ERC20: EthAddress = ERC20_A;
global PORTAL: EthAddress = PORTAL_A;
global NAME: str<31> = NAME_A;
global SYMBOL: str<31> = SYMBOL_A;

// tx A: registration + a public claim in ONE transaction. The hub-enqueued constructor runs before
// `claim_public`'s mint, and the derived address equals the pre-registered instance.
#[test]
unconstrained fn register_and_claim_public_in_one_tx() {
    let h = setup();
    let token = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));

    assert(h.env.view_public(TokenBridgeHub::at(h.hub).token_for(ERC20)) == AztecAddress::zero());

    let reg_leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    let amount: u128 = 1_000;
    let secret = 0xCAFE;
    let dep_leaf = send_mint_to_public_message(h, PORTAL, h.admin, amount, secret);

    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_and_claim_public(
            ERC20,
            PORTAL,
            name_word,
            symbol_word,
            DECIMALS,
            reg_leaf,
            h.admin,
            amount,
            secret,
            dep_leaf,
        ),
    );

    assert(h.env.view_public(TokenBridgeHub::at(h.hub).token_for(ERC20)) == token);
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).portal_for(token)) == PORTAL);
    assert(h.env.view_public(Token::at(token).balance_of_public(h.admin)) == amount);
}

// tx B: the private first claim is its own transaction after registration has been mined.
#[test]
unconstrained fn claim_private_after_registration() {
    let mut h = setup();
    let recipient = h.env.create_contract_account();
    let token = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));

    let reg_leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, reg_leaf),
    );

    let amount: u128 = 250;
    let salt = 0x5A17;
    let dep_leaf = send_mint_to_private_message(h, PORTAL, recipient, amount, salt);
    h.env.call_private(
        recipient,
        TokenBridgeHub::at(h.hub).claim_private(token, recipient, amount, salt, dep_leaf),
    );

    let bal = h.env.execute_utility(Token::at(token).balance_of_private(recipient));
    assert(bal == amount);
}

// Wrong metadata fails in the private phase — no publish, no bind. (That a correct registration
// still succeeds afterwards is a sandbox assertion: a failed TXE call ends the test.)
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn wrong_metadata_fails_before_any_side_effect() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let reg_leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);

    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, 6, reg_leaf),
    );
}

// The plain bind (no claim) is the relayer's shape. (A retry after a wrong attempt cannot be
// observed here — a failed call aborts the test — the sandbox smoke covers it.)
#[test]
unconstrained fn bind_token_alone_registers() {
    let h = setup();
    let token = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let reg_leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);

    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, reg_leaf),
    );
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).token_for(ERC20)) == token);
}

// ── Sender, portal and replay guards ───────────────────────────────────────────────────────

// A `register` leaf from any L1 sender but the factory is invisible to the hub: the message is keyed
// by its sender, so a look-alike factory cannot attest a portal.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn register_from_foreign_sender_rejected() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message_from(
        h,
        EthAddress::from_field(0xBAD),
        ERC20,
        PORTAL,
        name_word,
        symbol_word,
        DECIMALS,
    );
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );
}

// The portal is inside the hashed content: binding a different portal than the factory attested is
// a different message.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn register_with_swapped_portal_rejected() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(
            ERC20,
            EthAddress::from_field(0xBAD),
            name_word,
            symbol_word,
            DECIMALS,
            leaf,
        ),
    );
}

// A consumed leaf is nullified: a second bind of the same message finds nothing to consume and
// cannot re-run the constructor or re-point anything.
#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn register_replay_of_same_leaf_rejected() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );
}

// First registration wins: a second factory-authored leaf for the same ERC-20 with DIFFERENT words
// derives a different token, and its `_register` dies on `token_of`'s initialization nullifier —
// the existing pairing cannot be re-pointed even by a genuine factory message.
#[test(should_fail_with = "Attempted to emit duplicate nullifier")]
unconstrained fn second_factory_leaf_for_same_erc20_rejected() {
    let h = setup();
    let _ = register_a(h);

    let other_name: str<31> = "Impostor00000000000000000000000";
    let _ = pre_register_token(h, ERC20, other_name, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(other_name), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );
}

// A relayer (anyone) may register; the depositor's claim then succeeds unchanged.
#[test]
unconstrained fn relayer_registers_then_depositor_claims() {
    let mut h = setup();
    let stranger = h.env.create_light_account();
    let depositor = h.env.create_light_account();
    let token = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        stranger,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );

    let amount: u128 = 42;
    let dep_leaf = send_mint_to_public_message(h, PORTAL, depositor, amount, 0xD3);
    h.env.call_public(
        depositor,
        TokenBridgeHub::at(h.hub).claim_public(token, depositor, amount, 0xD3, dep_leaf),
    );
    assert(h.env.view_public(Token::at(token).balance_of_public(depositor)) == amount);
}

// A register-and-claim for an already-registered token replays its register leaf and dies there;
// the plain claim is the path for every later depositor.
#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn register_and_claim_for_registered_token_rejected() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );
    let dep_leaf = send_mint_to_public_message(h, PORTAL, h.admin, 7, 0xD3);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_and_claim_public(
            ERC20,
            PORTAL,
            name_word,
            symbol_word,
            DECIMALS,
            leaf,
            h.admin,
            7,
            0xD3,
            dep_leaf,
        ),
    );
}

// A message the REAL factory sent (secret 0) is beyond the harness entrypoints: on a live network
// nobody can spend a token's one-shot leaf through the publish-free path.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn bind_cannot_consume_a_real_factory_leaf() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_factory_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );
}

// The production entrypoint consumes the factory's leaf and then publishes. The TXE never mines a
// class nullifier, so the publish dies on that read — AFTER the consume — which pins that
// `register_token` consumes with the factory secret and reaches the publish (a wrapper that quietly
// skipped it would bind here instead of failing).
#[test(should_fail_with = "is reading an unknown nullifier")]
unconstrained fn register_token_reaches_the_publish() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_factory_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).register_token(ERC20, PORTAL, name_word, symbol_word, DECIMALS, leaf),
    );
}

#[test(should_fail_with = "is reading an unknown nullifier")]
unconstrained fn register_and_claim_public_reaches_the_publish() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_factory_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    let dep_leaf = send_mint_to_public_message(h, PORTAL, h.admin, 7, 0xD3);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).register_and_claim_public(
            ERC20,
            PORTAL,
            name_word,
            symbol_word,
            DECIMALS,
            leaf,
            h.admin,
            7,
            0xD3,
            dep_leaf,
        ),
    );
}

// Every attested field is inside the content hash — a client that swaps or mistypes a word is
// binding a message that does not exist.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn register_with_swapped_words_rejected() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, symbol_word, name_word, DECIMALS, leaf),
    );
}

#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn register_with_wrong_name_word_rejected() {
    let h = setup();
    let _ = pre_register_token(h, ERC20, NAME, SYMBOL, DECIMALS);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL, word(NAME_B), symbol_word, DECIMALS, leaf),
    );
}

// Same words, different portal: the derived token is the same, so the second leaf dies on
// `portal_of`'s initialization — the other branch of first-registration-wins.
#[test(should_fail_with = "Attempted to emit duplicate nullifier")]
unconstrained fn second_factory_leaf_with_same_words_different_portal_rejected() {
    let h = setup();
    let _ = register_a(h);
    let (name_word, symbol_word) = (word(NAME), word(SYMBOL));
    let leaf = send_register_message(h, ERC20, PORTAL_B, name_word, symbol_word, DECIMALS);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(ERC20, PORTAL_B, name_word, symbol_word, DECIMALS, leaf),
    );
}

// ── Two tokens, discovery, decimals range ──────────────────────────────────────────────────

#[test]
unconstrained fn two_tokens_register_independently() {
    let h = setup();
    let a = register_a(h);
    let b = register(h, ERC20_B, PORTAL_B, NAME_B, SYMBOL_B, 6);
    assert(a != b);
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).token_for(ERC20_A)) == a);
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).token_for(ERC20_B)) == b);
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).portal_for(a)) == PORTAL_A);
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).portal_for(b)) == PORTAL_B);
    assert(h.env.view_public(Token::at(a).decimals()) == DECIMALS);
    assert(h.env.view_public(Token::at(b).decimals()) == 6);
}

#[test]
unconstrained fn discovery_reads_zero_for_unregistered() {
    let h = setup();
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).token_for(ERC20_A)) == AztecAddress::zero());
    assert(
        h.env.view_public(TokenBridgeHub::at(h.hub).portal_for(AztecAddress::from_field(0x1234)))
            == EthAddress::zero(),
    );
}

#[test]
unconstrained fn decimals_extremes_register() {
    let h = setup();
    let zero = register(h, ERC20_A, PORTAL_A, NAME_A, SYMBOL_A, 0);
    let max = register(h, ERC20_B, PORTAL_B, NAME_B, SYMBOL_B, 255);
    assert(h.env.view_public(Token::at(zero).decimals()) == 0);
    assert(h.env.view_public(Token::at(max).decimals()) == 255);
}
