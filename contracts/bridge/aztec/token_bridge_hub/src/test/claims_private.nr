// claim_private over TWO registered tokens. The private content hash omits the recipient; the
// consumption secret is derived from the recipient in-circuit, so a relayer can submit but never
// redirect.

use crate::test::utils::{
    ERC20_B, fund_private, NAME_B, PORTAL_A, PORTAL_B, register, register_a, register_b,
    send_mint_to_private_message, setup, SYMBOL_B,
};
use crate::TokenBridgeHub;
use aztec::protocol::{address::AztecAddress, traits::FromField};
use token::Token;

global SALT: Field = 0x5A17;

#[test]
unconstrained fn claim_private_mints_notes_for_the_recipient() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    fund_private(h, a, PORTAL_A, user, 900, SALT);
    assert(h.env.execute_utility(Token::at(a).balance_of_private(user)) == 900);
    assert(h.env.view_public(Token::at(a).balance_of_public(user)) == 0);
}

// The committed recipient is the only one the derived secret opens for.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_private_redirect_to_another_recipient_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let thief = h.env.create_contract_account();
    let a = register_a(h);
    let leaf = send_mint_to_private_message(h, PORTAL_A, user, 900, SALT);
    h.env.call_private(thief, TokenBridgeHub::at(h.hub).claim_private(a, thief, 900, SALT, leaf));
}

#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_private_message_from_portal_a_cannot_mint_token_b() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let _a = register_a(h);
    let b = register_b(h);
    let leaf = send_mint_to_private_message(h, PORTAL_A, user, 900, SALT);
    h.env.call_private(user, TokenBridgeHub::at(h.hub).claim_private(b, user, 900, SALT, leaf));
}

#[test]
unconstrained fn claim_private_two_tokens_credit_independently() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    let b = register(h, ERC20_B, PORTAL_B, NAME_B, SYMBOL_B, 6);
    fund_private(h, a, PORTAL_A, user, 100, 1);
    fund_private(h, b, PORTAL_B, user, 7, 2);
    assert(h.env.execute_utility(Token::at(a).balance_of_private(user)) == 100);
    assert(h.env.execute_utility(Token::at(b).balance_of_private(user)) == 7);
}

// The private read of an unregistered token's portal fails on the uninitialized slot too.
#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn claim_private_unregistered_token_reverts() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let leaf = send_mint_to_private_message(h, PORTAL_A, user, 5, SALT);
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).claim_private(AztecAddress::from_field(0xDEAD), user, 5, SALT, leaf),
    );
}

#[test(should_fail_with = "Amount must be greater than zero")]
unconstrained fn claim_private_zero_amount_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    h.env.call_private(user, TokenBridgeHub::at(h.hub).claim_private(a, user, 0, SALT, 0));
}

#[test(should_fail_with = "Recipient cannot be zero")]
unconstrained fn claim_private_zero_recipient_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).claim_private(a, AztecAddress::zero(), 5, SALT, 0),
    );
}

#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_private_wrong_salt_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    let leaf = send_mint_to_private_message(h, PORTAL_A, user, 5, SALT);
    h.env.call_private(user, TokenBridgeHub::at(h.hub).claim_private(a, user, 5, SALT + 1, leaf));
}

#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn claim_private_replay_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    let leaf = send_mint_to_private_message(h, PORTAL_A, user, 5, SALT);
    h.env.call_private(user, TokenBridgeHub::at(h.hub).claim_private(a, user, 5, SALT, leaf));
    h.env.call_private(user, TokenBridgeHub::at(h.hub).claim_private(a, user, 5, SALT, leaf));
}

// A relayer may submit the private claim; the notes belong to the committed recipient.
#[test]
unconstrained fn claim_private_by_relayer_credits_the_recipient() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let relayer = h.env.create_contract_account();
    let a = register_a(h);
    let leaf = send_mint_to_private_message(h, PORTAL_A, user, 5, SALT);
    h.env.call_private(relayer, TokenBridgeHub::at(h.hub).claim_private(a, user, 5, SALT, leaf));
    assert(h.env.execute_utility(Token::at(a).balance_of_private(user)) == 5);
    assert(h.env.execute_utility(Token::at(a).balance_of_private(relayer)) == 0);
}
