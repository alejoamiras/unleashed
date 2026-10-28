/** The relayer's key, from the Worker's secret or a keyed run's environment. */
import type { Hex } from "viem"
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts"

/**
 * `RELAYER_PRIVATE_KEY` as an account. No error carries the value.
 *
 * @throws when the variable is missing, malformed or not a valid secp256k1 key.
 */
export function relayerAccount(env: Readonly<Record<string, unknown>>): PrivateKeyAccount {
	const key = env.RELAYER_PRIVATE_KEY
	if (typeof key !== "string" || key === "") throw new Error("RELAYER_PRIVATE_KEY is not set")
	if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("RELAYER_PRIVATE_KEY is not a 0x-prefixed 32-byte key")
	try {
		return privateKeyToAccount(key as Hex)
	} catch {
		throw new Error("RELAYER_PRIVATE_KEY is not a valid secp256k1 key")
	}
}
