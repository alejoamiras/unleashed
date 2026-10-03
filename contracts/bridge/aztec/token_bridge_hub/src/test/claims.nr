use crate::test::utils::{
    ERC20_B, fund_public, NAME_B, PORTAL_A, PORTAL_B, register, register_a, register_b,
    send_mint_to_public_message, setup, SYMBOL_B,
};
use crate::TokenBridgeHub;
use aztec::protocol::{address::AztecAddress, traits::FromField};
use token::Token;

global SECRET: Field = 0x5EC7E7;

#[test]
unconstrained fn claim_public_mints_the_registered_token() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    fund_public(h, a, PORTAL_A, user, 1_000, SECRET);
    assert(h.env.view_public(Token::at(a).balance_of_public(user)) == 1_000);
    assert(h.env.view_public(Token::at(a).total_supply()) == 1_000);
}

// Each token's portal is its own message sender: a deposit through portal A can only ever mint A.
#[test(should_fail_with = "Tried to consume nonexistent L1-to-L2 message")]
unconstrained fn claim_public_message_from_portal_a_cannot_mint_token_b() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let _a = register_a(h);
    let b = register_b(h);
    let leaf = send_mint_to_public_message(h, PORTAL_A, user, 500, SECRET);
    h.env.call_public(user, TokenBridgeHub::at(h.hub).claim_public(b, user, 500, SECRET, leaf));
}

#[test]
unconstrained fn claim_public_two_tokens_credit_independently() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let b = register(h, ERC20_B, PORTAL_B, NAME_B, SYMBOL_B, 6);
    fund_public(h, a, PORTAL_A, user, 100, 1);
    fund_public(h, b, PORTAL_B, user, 7, 2);
    assert(h.env.view_public(Token::at(a).balance_of_public(user)) == 100);
    assert(h.env.view_public(Token::at(b).balance_of_public(user)) == 7);
}

// An unregistered token has no portal to read: the claim dies on the uninitialized slot, never on a
// zero-portal message lookup that some other sender could satisfy.
#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn claim_public_unregistered_token_reverts() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let leaf = send_mint_to_public_message(h, PORTAL_A, user, 5, SECRET);
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).claim_public(AztecAddress::from_field(0xDEAD), user, 5, SECRET, leaf),
    );
}

#[test(should_fail_with = "Amount must be greater than zero")]
unconstrained fn claim_public_zero_amount_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    h.env.call_public(user, TokenBridgeHub::at(h.hub).claim_public(a, user, 0, SECRET, 0));
}

#[test(should_fail_with = "Tried to consume nonexistent L1-to-L2 message")]
unconstrained fn claim_public_wrong_secret_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let leaf = send_mint_to_public_message(h, PORTAL_A, user, 5, SECRET);
    h.env.call_public(user, TokenBridgeHub::at(h.hub).claim_public(a, user, 5, SECRET + 1, leaf));
}

// The recipient is inside the public content hash: a claim cannot be re-aimed.
#[test(should_fail_with = "Tried to consume nonexistent L1-to-L2 message")]
unconstrained fn claim_public_wrong_recipient_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let thief = h.env.create_light_account();
    let a = register_a(h);
    let leaf = send_mint_to_public_message(h, PORTAL_A, user, 5, SECRET);
    h.env.call_public(thief, TokenBridgeHub::at(h.hub).claim_public(a, thief, 5, SECRET, leaf));
}

#[test(should_fail_with = "Tried to consume nonexistent L1-to-L2 message")]
unconstrained fn claim_public_wrong_amount_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let leaf = send_mint_to_public_message(h, PORTAL_A, user, 5, SECRET);
    h.env.call_public(user, TokenBridgeHub::at(h.hub).claim_public(a, user, 6, SECRET, leaf));
}

#[test(should_fail_with = "L1-to-L2 message is already nullified")]
unconstrained fn claim_public_replay_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let leaf = send_mint_to_public_message(h, PORTAL_A, user, 5, SECRET);
    h.env.call_public(user, TokenBridgeHub::at(h.hub).claim_public(a, user, 5, SECRET, leaf));
    h.env.call_public(user, TokenBridgeHub::at(h.hub).claim_public(a, user, 5, SECRET, leaf));
}

// Anyone may submit a public claim; the tokens land with the committed recipient, not the caller.
#[test]
unconstrained fn claim_public_by_relayer_credits_the_recipient() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let relayer = h.env.create_light_account();
    let a = register_a(h);
    let leaf = send_mint_to_public_message(h, PORTAL_A, user, 5, SECRET);
    h.env.call_public(relayer, TokenBridgeHub::at(h.hub).claim_public(a, user, 5, SECRET, leaf));
    assert(h.env.view_public(Token::at(a).balance_of_public(user)) == 5);
    assert(h.env.view_public(Token::at(a).balance_of_public(relayer)) == 0);
}
