import { Fr } from "@aztec-labs/aztec.js/fields"

/** An approximately uniform BN254 scalar: 64 WebCrypto bytes reduced mod r (statistical distance below 2^-258). */
export function randomField(): Fr {
	const bytes = crypto.getRandomValues(new Uint8Array(64))
	return new Fr(BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`) % Fr.MODULUS)
}
