import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { computeSiloedPrivateInitializationNullifier } from "@aztec-labs/stdlib/hash"
import { describe, expect, it } from "vitest"
import { tokenBridgeHubArtifact } from "../src/artifacts"
import type { HubClaimParams } from "../src/hub-l2"
import { deriveHubTokenInstance } from "../src/hub-token"
import type { ManifestToken } from "../src/manifest-v2"
import { claimTokensUntilSynced, deployAccountIfAbsent, deriveInstance, registerHub, registerHubToken } from "./script-l2"

const FACTORY = "0x3333333333333333333333333333333333333333"
const GUARDIAN = `0x${"0".repeat(61)}ab1`
/** The installed aztec-standards@6.0.0-rc.1 Token class — the same pin as noir-artifact-classids.test.ts. */
const TOKEN_CLASS_ID = "0x24c34002788720c941a327a20c369b12c8bdcff3b5a974673a8f618763471505"
const ERC20 = "0x00000000000000000000000000000000000e2c20"
const HUB_SALT = `0x${"0".repeat(24)}${FACTORY.slice(2)}`

const hubArgs = [Fr.fromHexString(TOKEN_CLASS_ID), EthAddress.fromString(FACTORY), AztecAddress.fromStringUnsafe(GUARDIAN)]

const manifestToken = (l2Token: string): ManifestToken => ({
	erc20: ERC20,
	portal: "0x00000000000000000000000000000000000000a1",
	l2Token,
	nameWord: "0x005465737420546f6b656e000000000000000000000000000000000000000000",
	symbolWord: "0x0054535400000000000000000000000000000000000000000000000000000000",
	decimals: 18,
	displayName: "Test Token",
	displaySymbol: "TST",
	source: "permissionless-mint",
	sourceContract: "TestUsdc",
})

/** Records what a script taught the wallet; `Contract.at` only reads the artifact, never the wallet. */
function fakeWallet() {
	const registered: { classes: number; instances: string[] } = { classes: 0, instances: [] }
	const wallet = {
		registerContractClass: async () => {
			registered.classes += 1
		},
		registerContract: async (instance: { address: { toString: () => string } }) => {
			registered.instances.push(instance.address.toString())
		},
	}
	return { wallet: wallet as unknown as Wallet, registered }
}

describe("script-l2", () => {
	it("deriveInstance is deployer-sensitive: the same salt and args under a different deployer is a different address", async () => {
		const salt = Fr.fromHexString(HUB_SALT)
		const universal = await deriveInstance(tokenBridgeHubArtifact, hubArgs, "constructor", salt, AztecAddress.ZERO)
		const deployed = await deriveInstance(tokenBridgeHubArtifact, hubArgs, "constructor", salt, AztecAddress.fromStringUnsafe(GUARDIAN))
		expect(universal.address.toString()).not.toBe(deployed.address.toString())
		expect(universal.deployer.isZero()).toBe(true)
	})

	it("registerHub asserts the recorded address, then registers the class and the instance", async () => {
		const expected = await deriveInstance(tokenBridgeHubArtifact, hubArgs, "constructor", Fr.fromHexString(HUB_SALT), AztecAddress.ZERO)
		const record = {
			address: expected.address.toString(),
			salt: HUB_SALT,
			constructorArtifact: "constructor",
			constructorArgs: [TOKEN_CLASS_ID, FACTORY, GUARDIAN],
		}
		const { wallet, registered } = fakeWallet()
		const hub = await registerHub(wallet, record)
		expect(hub.address.toString()).toBe(record.address)
		expect(registered).toEqual({ classes: 1, instances: [record.address] })

		const guard = fakeWallet()
		await expect(registerHub(guard.wallet, { ...record, address: `0x${"11".repeat(32)}` })).rejects.toThrow(
			/manifest hub mismatch: derived .* != recorded/,
		)
	})

	it("registerHubToken asserts the hub's derivation for the token and registers it", async () => {
		const hub = AztecAddress.fromStringUnsafe("0x1234000000000000000000000000000000000000000000000000000000000abc")
		const derived = await deriveHubTokenInstance(hub, ERC20, manifestToken("0x0"), TOKEN_CLASS_ID)
		const token = manifestToken(derived.address.toString())

		const { wallet, registered } = fakeWallet()
		const contract = await registerHubToken(wallet, hub, token, TOKEN_CLASS_ID)
		expect(contract.address.toString()).toBe(token.l2Token)
		expect(registered.instances).toEqual([token.l2Token])

		const guard = fakeWallet()
		await expect(registerHubToken(guard.wallet, hub, { ...token, l2Token: `0x${"11".repeat(32)}` }, TOKEN_CLASS_ID)).rejects.toThrow(
			/manifest token TST mismatch/,
		)
	})

	it("claimTokensUntilSynced retries only while the message is unsynced and returns the claim outcome", async () => {
		const claim: HubClaimParams = {
			token: {
				erc20: ERC20,
				portal: "0x00000000000000000000000000000000000000a1",
				l2Token: `0x${"11".repeat(32)}`,
				nameWord: "0x00",
				symbolWord: "0x00",
				decimals: 18,
				displaySymbol: "TST",
				registerIndex: "5",
			},
			recipient: `0x${"22".repeat(32)}`,
			amount: 5n,
			claimValue: new Fr(7n),
			leafIndex: 9n,
			isPrivate: false,
			from: `0x${"22".repeat(32)}`,
		}
		// The public path's assert wording, then the private witness helper's — both mean "not yet".
		const unsynced = [
			"Assertion failed: Tried to consume nonexistent L1-to-L2 message 'assert(self.l1_to_l2_msg_exists(message_hash, leaf_index), \"…\")'",
			"No L1 to L2 message found for message hash 0xabc",
		]
		let sends = 0
		const hub = {
			methods: new Proxy(
				{},
				{
					get: (_t, name: string) => () => ({
						simulate: async () => ({ result: claim.token.l2Token }),
						send: async () => {
							sends += 1
							if (sends <= unsynced.length) throw new Error(unsynced[sends - 1])
							return { receipt: { txHash: `0x${name}` } }
						},
					}),
				},
			),
		} as unknown as ContractBase

		expect(await claimTokensUntilSynced({ hub, claim, sendOpts: {}, intervalMs: 0 })).toEqual({
			path: "claim",
			claimTxHash: "0xclaim_public",
		})
		expect(sends).toBe(3)
	})

	it.each([
		"Assertion failed: Balance too low",
		// An already-consumed message: waiting never helps, and it must not be mistaken for unsynced.
		"No non-nullified L1 to L2 message found for message hash 0xabc",
	])("claimTokensUntilSynced surfaces a non-sync failure on the first attempt: %s", async (wording) => {
		const hub = {
			methods: new Proxy(
				{},
				{
					get: () => () => ({
						simulate: async () => ({ result: `0x${"11".repeat(32)}` }),
						send: async () => {
							throw new Error(wording)
						},
					}),
				},
			),
		} as unknown as ContractBase
		await expect(
			claimTokensUntilSynced({
				hub,
				claim: {
					token: {
						erc20: ERC20,
						portal: "0x00000000000000000000000000000000000000a1",
						l2Token: `0x${"11".repeat(32)}`,
						nameWord: "0x00",
						symbolWord: "0x00",
						decimals: 18,
						displaySymbol: "TST",
					},
					recipient: `0x${"22".repeat(32)}`,
					amount: 5n,
					claimValue: new Fr(7n),
					leafIndex: 9n,
					isPrivate: true,
					from: `0x${"22".repeat(32)}`,
				},
				sendOpts: {},
				intervalMs: 0,
				attempts: 5,
			}),
		).rejects.toThrow(wording)
	})

	it("deployAccountIfAbsent no-ops when the node serves the account OR its init nullifier exists, else sends NO_FROM with the fee", async () => {
		const log: string[] = []
		const from = AztecAddress.fromStringUnsafe(`0x${"1".padStart(64, "0")}`)
		const instance = { initializationHash: new Fr(7) }
		const expectedNullifier = await computeSiloedPrivateInitializationNullifier(from, instance.initializationHash)
		const refusing = {
			getDeployMethod: async () => {
				throw new Error("must not deploy")
			},
			getInstance: () => instance,
		}
		const served = {
			node: { getContract: async () => ({}), getNullifierMembershipWitness: async () => undefined },
			manager: refusing,
			from,
			fee: { paymentMethod: "sponsored" },
			log: (s: string) => log.push(s),
		}
		await deployAccountIfAbsent(served as never)
		expect(log).toEqual([])

		// An account deploy publishes no instance: the node never serves it, only its init nullifier.
		const witnessed: Fr[] = []
		const initialized = {
			...served,
			node: {
				getContract: async () => undefined,
				getNullifierMembershipWitness: async (_b: string, n: Fr) => {
					witnessed.push(n)
					return n.equals(expectedNullifier) ? {} : undefined
				},
			},
		}
		await deployAccountIfAbsent(initialized as never)
		expect(witnessed).toEqual([expectedNullifier])
		expect(log).toEqual([])

		let sent: { fee: unknown; from: unknown } | undefined
		const absent = {
			node: { getContract: async () => undefined, getNullifierMembershipWitness: async () => undefined },
			manager: {
				getDeployMethod: async () => ({
					send: async (o: { fee: unknown; from: unknown }) => {
						sent = o
					},
				}),
				getInstance: () => instance,
			},
			from,
			fee: { paymentMethod: "sponsored" },
			log: (s: string) => log.push(s),
		}
		await deployAccountIfAbsent(absent as never)
		expect(sent?.from).toBe("NO_FROM")
		expect(sent?.fee).toEqual({ paymentMethod: "sponsored" })
		expect(log).toEqual(["deploying", "deployed"])
	})
})
