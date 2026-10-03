use crate::test::utils::{ERC20_A, PORTAL_A, register_a, setup};
use crate::TokenBridgeHub;
use aztec::protocol::{address::{AztecAddress, EthAddress}, traits::FromField};

// A direct `_register` would let anyone pair an arbitrary token with an arbitrary portal.
#[test(should_fail_with = "can only be called by the same contract")]
unconstrained fn _register_only_self() {
    let mut h = setup();
    let stranger = h.env.create_light_account();
    h.env.call_public(
        stranger,
        TokenBridgeHub::at(h.hub)._register(
            ERC20_A,
            PORTAL_A,
            AztecAddress::from_field(0xDEAD),
        ),
    );
}

// Even the guardian cannot re-point a registered token through `_register`.
#[test(should_fail_with = "can only be called by the same contract")]
unconstrained fn _register_only_self_even_for_guardian() {
    let h = setup();
    let a = register_a(h);
    h.env.call_public(
        h.guardian,
        TokenBridgeHub::at(h.hub)._register(ERC20_A, EthAddress::from_field(0xBAD), a),
    );
}

#[test(should_fail_with = "can only be called by the same contract")]
unconstrained fn _assert_exits_open_only_self() {
    let mut h = setup();
    let stranger = h.env.create_light_account();
    h.env.call_public(stranger, TokenBridgeHub::at(h.hub)._assert_exits_open());
}
