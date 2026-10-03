// exit_to_l1_public / exit_to_l1_private over TWO tokens: burn the caller's balance of THAT token
// and enqueue the withdraw message to THAT token's portal. The TXE has no outgoing-message oracle,
// so the burn is the assertion surface; the message content is pinned by the keystone crate +
// ContentHash.t.sol.

use crate::test::utils::{
    fund_private, fund_public, L1_RECIPIENT, NONCE, PORTAL_A, PORTAL_B, register_a, register_b, setup,
};
use crate::TokenBridgeHub;
use aztec::{
    protocol::{address::{AztecAddress, EthAddress}, traits::FromField},
    test::helpers::authwit::{add_private_authwit_from_call, add_public_authwit_from_call},
};
use token::Token;


#[test]
unconstrained fn exit_public_burns_the_caller_balance() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    fund_public(h, a, PORTAL_A, user, 2_000, 1);

    // The token sees msg_sender == hub, so the user authorizes the hub for exactly this burn.
    add_public_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_public(user, 700, NONCE));
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(a, L1_RECIPIENT, 700, EthAddress::zero(), NONCE),
    );
    assert(h.env.view_public(Token::at(a).balance_of_public(user)) == 1_300);
    assert(h.env.view_public(Token::at(a).total_supply()) == 1_300);
}

#[test]
unconstrained fn exit_private_burns_the_private_balance() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    fund_private(h, a, PORTAL_A, user, 900, 1);

    add_private_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_private(user, 400, NONCE));
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_private(a, L1_RECIPIENT, 400, EthAddress::zero(), NONCE),
    );
    assert(h.env.execute_utility(Token::at(a).balance_of_private(user)) == 500);
}

// An authwit is bound to the token it was granted for: authorizing a burn on A does not let the hub
// burn B, because the consumer of the authwit is Token B, which was never authorized.
#[test(should_fail_with = "unauthorized")]
unconstrained fn exit_public_authwit_for_token_a_replayed_against_token_b_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let b = register_b(h);
    fund_public(h, a, PORTAL_A, user, 100, 1);
    fund_public(h, b, PORTAL_B, user, 100, 2);

    add_public_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_public(user, 50, NONCE));
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(b, L1_RECIPIENT, 50, EthAddress::zero(), NONCE),
    );
}

#[test(should_fail_with = "Unknown auth witness for message hash")]
unconstrained fn exit_private_authwit_for_token_a_replayed_against_token_b_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    let b = register_b(h);
    fund_private(h, a, PORTAL_A, user, 100, 1);
    fund_private(h, b, PORTAL_B, user, 100, 2);

    add_private_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_private(user, 50, NONCE));
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_private(b, L1_RECIPIENT, 50, EthAddress::zero(), NONCE),
    );
}

#[test(should_fail_with = "unauthorized")]
unconstrained fn exit_public_without_authwit_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    fund_public(h, a, PORTAL_A, user, 100, 1);
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(a, L1_RECIPIENT, 50, EthAddress::zero(), NONCE),
    );
}

// An unregistered token has no portal: nothing to message, nothing to burn.
#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn exit_public_unregistered_token_reverts() {
    let mut h = setup();
    let user = h.env.create_light_account();
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(
            AztecAddress::from_field(0xDEAD),
            L1_RECIPIENT,
            1,
            EthAddress::zero(),
            NONCE,
        ),
    );
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn exit_private_unregistered_token_reverts() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_private(
            AztecAddress::from_field(0xDEAD),
            L1_RECIPIENT,
            1,
            EthAddress::zero(),
            NONCE,
        ),
    );
}

#[test(should_fail_with = "Recipient cannot be zero")]
unconstrained fn exit_public_zero_recipient_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(a, EthAddress::zero(), 1, EthAddress::zero(), NONCE),
    );
}

#[test(should_fail_with = "Recipient cannot be zero")]
unconstrained fn exit_private_zero_recipient_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_private(a, EthAddress::zero(), 1, EthAddress::zero(), NONCE),
    );
}

#[test(should_fail_with = "Amount must be greater than zero")]
unconstrained fn exit_public_zero_amount_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(a, L1_RECIPIENT, 0, EthAddress::zero(), NONCE),
    );
}

#[test(should_fail_with = "Amount must be greater than zero")]
unconstrained fn exit_private_zero_amount_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_private(a, L1_RECIPIENT, 0, EthAddress::zero(), NONCE),
    );
}

// Exiting more than the caller holds must die on the burn rather than emit a withdraw message for
// value that was never destroyed — the shape that would let one balance be exited twice.
#[test(should_fail_with = "attempt to subtract with overflow")]
unconstrained fn exit_public_insufficient_balance_rejected() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    fund_public(h, a, PORTAL_A, user, 100, 1);
    add_public_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_public(user, 101, NONCE));
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(a, L1_RECIPIENT, 101, EthAddress::zero(), NONCE),
    );
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn exit_private_insufficient_balance_rejected() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    fund_private(h, a, PORTAL_A, user, 100, 1);
    add_private_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_private(user, 101, NONCE));
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_private(a, L1_RECIPIENT, 101, EthAddress::zero(), NONCE),
    );
}
