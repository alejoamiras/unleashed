// KEYSTONE: proves the Noir content-hashes equal the L1 (Solidity) ones for
// fixed vectors. The matching L1 assertions live in contracts/bridge/evm
// (test/ContentHash.t.sol) against the SAME constants. Equality across both
// toolchains is the one cross-chain boundary guard the TXE can't provide: if a
// selector or arg order ever drifts, a deposit's L1->L2 message becomes
// unconsumable and funds strand. Run: nargo test (with the 5.0.0 nargo).

use aztec::hash::compute_secret_hash;
use aztec::protocol::address::{AztecAddress, EthAddress};
use aztec::protocol::traits::FromField;
use claim_secret_lib::{derive_claim_secret, DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET};
use token_portal_content_hash_lib::{
    get_mint_to_private_content_hash, get_mint_to_public_content_hash, get_withdraw_content_hash,
};

fn main() {}

#[test]
fn mint_to_public_matches_l1() {
    let to = AztecAddress::from_field(0x1234);
    let h = get_mint_to_public_content_hash(to, 1_000_000);
    assert(h == 0x00fb464b41c6a08b28bfe9b8a11c1c4dcd2d4c9c66e703988cb76eb00e140dcc);
}

#[test]
fn mint_to_private_matches_l1() {
    let h = get_mint_to_private_content_hash(1_000_000);
    assert(h == 0x00009b1ee836fa551bb50bb45e2c8e698cc680c6e68e429370625119a2c63954);
}

#[test]
fn withdraw_matches_l1() {
    let recipient = EthAddress::from_field(0xBEEF);
    let caller = EthAddress::zero();
    let h = get_withdraw_content_hash(recipient, 1_000_000, caller);
    assert(h == 0x00ac390e12f1097130e1a7c2e5eea30780cd11d12002b8de22d608cf10a60775);
}

// ─── Recipient-committed private-claim secret derivation ─────────────
// The keystone's second cross-toolchain boundary: derive_claim_secret + compute_secret_hash
// must byte-match the TS mirror (packages/bridge-core/src/claim-secret.test.ts) for the SAME
// (salt, recipient) vectors — a drift strands every private deposit. The TS test asserts the
// identical literals.

// poseidon2_hash_bytes("unleashed_dom_sep__token_bridge_private_claim_secret") as u32. Distinct from the
// FPC fuel separator (3952304070) — the cross-protocol-secret-reuse tripwire.
#[test]
fn claim_secret_dom_sep_is_pinned() {
    assert(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET == 2317478496);
    assert(DOM_SEP__TOKEN_BRIDGE_PRIVATE_CLAIM_SECRET != 3952304070);
}

#[test]
fn claim_secret_vectors_match_ts() {
    // (salt, recipient) -> derived secret
    let s0 = derive_claim_secret(0, AztecAddress::from_field(0));
    assert(s0 == 0x1f17a9afc746bb16b48b40e27204959589a14c8da06e6562f1f730e71ba56571);
    let s1 = derive_claim_secret(1, AztecAddress::from_field(2));
    assert(s1 == 0x0e1c1bc4c90f0e15e3c4d18ad4ab43c07f8ff9c230d24a5295b41a32ae9fd397);
    let s2 = derive_claim_secret(0x1234567890abcdef, AztecAddress::from_field(0xdeadbeef));
    assert(s2 == 0x1bf3b96e42ed3d8ce072727e05ea920b23adf8a9effde855584a6a26d9f4eb37);
}

#[test]
fn claim_secret_hash_vectors_match_ts() {
    // compute_secret_hash([derive_claim_secret(...)]) — the value L1 commits into the message.
    // compute_secret_hash is generic over the array length (`[Field; N]`): a single secret is `[secret]`,
    // hashed as `poseidon2_hash_with_separator([secret], DOM_SEP__SECRET_HASH)`.
    let h0 = compute_secret_hash([derive_claim_secret(0, AztecAddress::from_field(0))]);
    assert(h0 == 0x21dda6113edeb23b9b0267ed92219f361a88095de9c7f47d80c208b3858f42fd);
    let h1 = compute_secret_hash([derive_claim_secret(1, AztecAddress::from_field(2))]);
    assert(h1 == 0x1ce9b36531e066f21da630794455329ccf900519a6873e7c9b710b245979ecdc);
    let h2 =
        compute_secret_hash([derive_claim_secret(0x1234567890abcdef, AztecAddress::from_field(0xdeadbeef))]);
    assert(h2 == 0x16b3c095d59a7813e217f2d377b94def432072bf495fae1ef2c15d6ac714b61c);
}

// ─── Fuzz properties (nargo runs parameterized tests with random inputs) ───
// The recipient-commitment property needs derive_claim_secret to be injective ENOUGH that a
// different (salt, recipient) never collides onto the committed secret; these random-input
// assertions pin the two one-bit-flip neighbors across the whole field domain.

#[test]
fn fuzz_derive_changes_with_salt(salt: Field, recipient_field: Field) {
    let r = AztecAddress::from_field(recipient_field);
    assert(
        derive_claim_secret(salt, r) != derive_claim_secret(salt + 1, r),
        "salt neighbor collision in derive_claim_secret",
    );
}

#[test]
fn fuzz_derive_changes_with_recipient(salt: Field, recipient_field: Field) {
    let r0 = AztecAddress::from_field(recipient_field);
    let r1 = AztecAddress::from_field(recipient_field + 1);
    assert(
        derive_claim_secret(salt, r0) != derive_claim_secret(salt, r1),
        "recipient neighbor collision in derive_claim_secret",
    );
}

// ─── Any-ERC-20 generation: the factory's `register` message ────────────────
// Fourth content-hash vector (PortalFactory.sol ↔ register_hash_lib ↔ bridge-core register-hash.ts)
// plus the public registration secret hash the factory hard-codes.

#[test]
fn register_matches_l1_and_ts() {
    let token = EthAddress::from_field(0xe2c20);
    let portal = EthAddress::from_field(0x9017a1);
    let name_word = 0x005465737420546f6b656e000000000000000000000000000000000000000000;
    let symbol_word = 0x0054535400000000000000000000000000000000000000000000000000000000;
    let h = register_hash_lib::get_register_content_hash(token, portal, name_word, symbol_word, 18);
    assert(h == 0x008c135ab10d3a0b9e221b83dd074a9051612d8bc8a8f6b2330960ba6e8dbda3);
}

#[test]
fn register_secret_hash_is_pinned() {
    assert(register_hash_lib::REGISTER_SECRET == 0);
    assert(
        register_hash_lib::register_secret_hash()
            == 0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250,
    );
}
