/**
 * The portal address for an ERC-20, computed the way `PortalFactory.predictPortal` does: an
 * OpenZeppelin immutable-args clone (`Clones.cloneDeterministicWithImmutableArgs`) with the token
 * address as the only immutable arg and `bytes32(uint160(token))` as the CREATE2 salt.
 *
 * The initcode is reproduced byte for byte rather than delegated to a generic minimal-proxy helper:
 * `61 <u16 runtime length> 3d81600a3d39f3 363d3d373d3d3d363d73 <impl> 5af43d82803e903d91602b57fd5bf3 <args>`.
 * With a 20-byte arg the runtime is 0x41 = 65 bytes and the initcode 75 bytes. Pinned against the
 * Solidity library by a fixed vector in `Keystone.t.sol` — a one-byte drift here strands deposits.
 */
import { concatHex, getCreate2Address, type Hex, pad } from "viem"

const PROXY_PREFIX: Hex = "0x3d81600a3d39f3363d3d373d3d3d363d73"
const PROXY_SUFFIX: Hex = "0x5af43d82803e903d91602b57fd5bf3"
const CLONE_RUNTIME_OVERHEAD = 0x2d

function assertAddress(hex: string, what: string): Hex {
	if (!/^0x[0-9a-fA-F]{40}$/.test(hex)) throw new Error(`${what} must be a 20-byte hex address`)
	return hex.toLowerCase() as Hex
}

/** The CREATE2 initcode of the clone for `erc20` behind `implementation`. */
export function portalInitCode(implementation: string, erc20: string): Hex {
	const impl = assertAddress(implementation, "implementation")
	const args = assertAddress(erc20, "erc20")
	const runtimeLength = (20 + CLONE_RUNTIME_OVERHEAD).toString(16).padStart(4, "0")
	return concatHex(["0x61", `0x${runtimeLength}`, PROXY_PREFIX, impl, PROXY_SUFFIX, args])
}

/** `bytes32(uint256(uint160(erc20)))` — the factory's salt. */
export function portalSalt(erc20: string): Hex {
	return pad(assertAddress(erc20, "erc20"), { size: 32 })
}

/** Lowercase, like every address the manifests carry — compare without re-checksumming. */
export function predictPortal(factory: string, implementation: string, erc20: string): Hex {
	return getCreate2Address({
		from: assertAddress(factory, "factory"),
		salt: portalSalt(erc20),
		bytecode: portalInitCode(implementation, erc20),
	}).toLowerCase() as Hex
}
