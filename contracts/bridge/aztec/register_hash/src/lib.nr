// The `register` message a PortalFactory sends when it creates a token's portal: the hub consumes it
// with the FACTORY as the L1 sender and the portal address inside the content, so the L1↔L2 pairing
// is attested by the deployer of the clone itself. Mirrors PortalFactory.sol byte for byte —
// selector ‖ pad32(token) ‖ pad32(portal) ‖ nameWord ‖ symbolWord ‖ pad32(decimals), sha256 → field.
// A drift here strands every deposit of that token: pinned by the keystone crate + bridge-core.
use aztec::hash::compute_secret_hash;
use aztec::protocol::{address::EthAddress, hash::sha256_to_field, traits::ToField};

/// Registration is permissionless, so its consumption secret is a public constant.
pub global REGISTER_SECRET: Field = 0;

/// The secret a TEST HARNESS commits its injected register messages to, so the hub's publish-free
/// entrypoints can consume them — and can never consume a real factory leaf.
pub global BIND_HARNESS_SECRET: Field = 0xB1AD;

pub fn register_secret_hash() -> Field {
    compute_secret_hash([REGISTER_SECRET])
}

/// `name_word` / `symbol_word` are the L1-sanitized 31-byte words as a big-endian field
/// (`0x00 ‖ b0..b30`), the same encoding `FieldCompressedString` uses.
pub fn get_register_content_hash(
    token: EthAddress,
    portal: EthAddress,
    name_word: Field,
    symbol_word: Field,
    decimals: u8,
) -> Field {
    let mut hash_bytes = [0; 164];
    let token_bytes: [u8; 32] = token.to_field().to_be_bytes();
    let portal_bytes: [u8; 32] = portal.to_field().to_be_bytes();
    let name_bytes: [u8; 32] = name_word.to_be_bytes();
    let symbol_bytes: [u8; 32] = symbol_word.to_be_bytes();
    let decimals_bytes: [u8; 32] = (decimals as Field).to_be_bytes();

    let selector = comptime {
        keccak256::keccak256("register(address,address,bytes32,bytes32,uint8)".as_bytes(), 47)
    };

    for i in 0..4 {
        hash_bytes[i] = selector[i];
    }
    for i in 0..32 {
        hash_bytes[i + 4] = token_bytes[i];
        hash_bytes[i + 36] = portal_bytes[i];
        hash_bytes[i + 68] = name_bytes[i];
        hash_bytes[i + 100] = symbol_bytes[i];
        hash_bytes[i + 132] = decimals_bytes[i];
    }

    sha256_to_field(hash_bytes)
}
