use crate::test::utils::{
    ERC20_A, fund_private, fund_public, L1_RECIPIENT, NONCE, PORTAL_A, register_a, setup,
};
use crate::TokenBridgeHub;
use aztec::{
    protocol::address::EthAddress,
    test::helpers::authwit::{add_private_authwit_from_call, add_public_authwit_from_call},
};
use token::Token;


#[test(should_fail_with = "not guardian")]
unconstrained fn non_guardian_cannot_pause() {
    let mut h = setup();
    let stranger = h.env.create_light_account();
    h.env.call_public(stranger, TokenBridgeHub::at(h.hub).set_exits_paused(true));
}

#[test(should_fail_with = "not guardian")]
unconstrained fn admin_is_not_the_guardian() {
    let h = setup();
    h.env.call_public(h.admin, TokenBridgeHub::at(h.hub).set_exits_paused(true));
}

#[test(should_fail_with = "exits paused")]
unconstrained fn public_exit_rejected_while_paused() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    fund_public(h, a, PORTAL_A, user, 100, 1);
    add_public_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_public(user, 50, NONCE));

    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(true));
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(a, L1_RECIPIENT, 50, EthAddress::zero(), NONCE),
    );
}

// The private exit's pause gate is the enqueued public assert, so the private phase (note
// nullification, authwit) succeeds first and the whole transaction reverts on it — funded and
// authorized beforehand, or the test would die on a missing note and prove nothing about pause.
#[test(should_fail_with = "exits paused")]
unconstrained fn private_exit_rejected_while_paused() {
    let mut h = setup();
    let user = h.env.create_contract_account();
    let a = register_a(h);
    fund_private(h, a, PORTAL_A, user, 100, 1);
    add_private_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_private(user, 50, NONCE));

    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(true));
    h.env.call_private(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_private(a, L1_RECIPIENT, 50, EthAddress::zero(), NONCE),
    );
}

// A deposit already made must always be claimable, whatever the guardian does.
#[test]
unconstrained fn claims_unaffected_while_paused() {
    let mut h = setup();
    let pub_user = h.env.create_light_account();
    let priv_user = h.env.create_contract_account();
    let a = register_a(h);
    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(true));

    fund_public(h, a, PORTAL_A, pub_user, 100, 1);
    fund_private(h, a, PORTAL_A, priv_user, 7, 2);
    assert(h.env.view_public(Token::at(a).balance_of_public(pub_user)) == 100);
    assert(h.env.execute_utility(Token::at(a).balance_of_private(priv_user)) == 7);
}

// Registration is a claim-side action too: a new token can still be brought over while paused.
#[test]
unconstrained fn registration_unaffected_while_paused() {
    let h = setup();
    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(true));
    let a = register_a(h);
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).token_for(ERC20_A)) == a);
}

// Unpausing restores exits. (Whether a refused exit burned nothing is atomicity the TXE cannot
// observe after the panic; the sandbox smoke exercises it.)
#[test]
unconstrained fn exits_resume_after_unpause() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    fund_public(h, a, PORTAL_A, user, 100, 1);

    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(true));
    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(false));
    assert(h.env.view_public(Token::at(a).balance_of_public(user)) == 100);

    add_public_authwit_from_call(h.env, user, h.hub, Token::at(a).burn_public(user, 50, NONCE));
    h.env.call_public(
        user,
        TokenBridgeHub::at(h.hub).exit_to_l1_public(a, L1_RECIPIENT, 50, EthAddress::zero(), NONCE),
    );
    assert(h.env.view_public(Token::at(a).balance_of_public(user)) == 50);
}

#[test]
unconstrained fn exits_paused_view_tracks_the_switch() {
    let h = setup();
    assert(!h.env.view_public(TokenBridgeHub::at(h.hub).exits_paused()));
    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(true));
    assert(h.env.view_public(TokenBridgeHub::at(h.hub).exits_paused()));
    h.env.call_public(h.guardian, TokenBridgeHub::at(h.hub).set_exits_paused(false));
    assert(!h.env.view_public(TokenBridgeHub::at(h.hub).exits_paused()));
}
