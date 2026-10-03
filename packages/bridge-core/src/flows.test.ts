import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { encodeAbiParameters, keccak256, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { tokenClaimSecretHash } from "./claim-secret"
import { runSwapBridge } from "./flows"
import { PRIVATE_FPC_ADDRESS, deriveBridgeSecret, privateFuelSecretHash } from "./private-fuel"
import { SWAP_BRIDGE_ROUTER_ABI } from "./router-abi"

const RECIPIENT = `0x${"3".padStart(64, "0")}` as const

const AZTEC_RECIPIENT = `0x${"a".padStart(64, "0")}` as const
const ADDR = "0x1111111111111111111111111111111111111111" as const

// Hand-built BridgeWithFuel log (tokenIndex 3, fuelIndex 7, fuelAmount 5000): 1 indexed
// (aztecRecipient) + 9 non-indexed in data, assembled by hand (the @aztec/viem fork has no encodeEventLog).
const bridgeWithFuelLog = {
	address: ADDR,
	topics: [
		keccak256(toHex("BridgeWithFuel(bytes32,bytes32,uint256,uint256,bytes32,bytes32,uint256,uint256,bytes32,bool)")),
		AZTEC_RECIPIENT,
	],
	data: encodeAbiParameters(
		[
			{ type: "bytes32" }, // tokenKey
			{ type: "uint256" }, // tokenIndex
			{ type: "uint256" }, // tokenAmount
			{ type: "bytes32" }, // tokenSecretHash
			{ type: "bytes32" }, // fuelKey
			{ type: "uint256" }, // fuelIndex
			{ type: "uint256" }, // fuelAmount
			{ type: "bytes32" }, // fuelSecretHash
			{ type: "bool" }, // isPrivate
		],
		[`0x${"0".repeat(64)}`, 3n, 100n, `0x${"0".repeat(64)}`, `0x${"0".repeat(64)}`, 7n, 5000n, `0x${"0".repeat(64)}`, true],
	),
	blockNumber: 1n,
	blockHash: `0x${"0".repeat(64)}`,
	logIndex: 0,
	transactionHash: `0x${"0".repeat(64)}`,
	transactionIndex: 0,
	removed: false,
}

describe("flows — runSwapBridge injectable fuel secret", () => {
	const makeL1 = () => ({
		pub: { waitForTransactionReceipt: vi.fn(async () => ({ logs: [bridgeWithFuelLog] })) },
		wallet: { signTypedData: vi.fn(async () => "0xsig"), writeContract: vi.fn(async () => "0xhash"), chain: { id: 31337 } },
		account: { address: ADDR },
	})
	const baseParams = {
		router: ADDR,
		routerAbi: SWAP_BRIDGE_ROUTER_ABI,
		permit2: ADDR,
		tokenPortal: ADDR,
		bridgeToken: ADDR,
		totalAmount: 1000n,
		fuelAmount: 100n,
		aztecRecipient: AZTEC_RECIPIENT,
		fuelRecipient: PRIVATE_FPC_ADDRESS as `0x${string}`,
		minFuelOutput: 1n,
		path: [],
		zeroForOnes: [],
		isPrivate: true,
		swapTarget: ADDR,
		tokenClaimSalt: new Fr(0x7abcn),
		nonce: 0n,
		deadline: 9_999_999_999n,
		chainId: 31337,
	}

	it("threads an injected derived secret into the on-chain witness + the result", async () => {
		const salt = Fr.zero()
		const claimer = AztecAddress.fromStringUnsafe(AZTEC_RECIPIENT)
		const injected = deriveBridgeSecret(salt, claimer)
		const l1 = makeL1()

		const res = await runSwapBridge(l1 as never, { ...baseParams, fuelSecret: injected } as never)

		expect(res.fuelSecretHex).toBe(injected.toString())
		expect(res.fuelLeafIndex).toBe(7n)
		expect(res.fuelReceived).toBe(5000n)
		// The value actually sent on-chain binds the injected secret — not a random one.
		const writeArg = (l1.wallet.writeContract.mock.calls[0] as unknown[])[0] as {
			functionName: string
			args: [{ fuelSecretHash: string }]
		}
		expect(writeArg.functionName).toBe("bridgeWithFuel")
		expect(writeArg.args[0].fuelSecretHash).toBe((await privateFuelSecretHash(salt, claimer)).toString())
		// The private TOKEN leg binds the recipient-committed secret derived from tokenClaimSalt —
		// the returned tokenSecretHex is the SALT (what claim_private takes), and the on-chain
		// tokenSecretHash is computeSecretHash(deriveTokenClaimSecret(salt, recipient)).
		expect(res.tokenSecretHex).toBe(new Fr(0x7abcn).toString())
		const tokenArg = writeArg.args[0] as unknown as { tokenSecretHash: string }
		expect(tokenArg.tokenSecretHash).toBe((await tokenClaimSecretHash(new Fr(0x7abcn), claimer)).toString())
	})

	// PRIVACY PIN: the recipient is committed via tokenSecretHash and must NOT be
	// published on-chain — the router ignores aztecRecipient on the private path but EMITS it as an
	// indexed event, so a real value would let any observer read R off L1 (defeating the salt-entropy
	// protection). A future refactor that re-passes the real recipient for private turns this red.
	it("PRIVACY: a private deposit zeroes the on-chain aztecRecipient while still committing to R", async () => {
		const l1 = makeL1()
		const claimer = AztecAddress.fromStringUnsafe(AZTEC_RECIPIENT)
		const injected = deriveBridgeSecret(Fr.zero(), claimer)
		await runSwapBridge(l1 as never, { ...baseParams, fuelSecret: injected } as never)

		const ZERO32 = `0x${"0".repeat(64)}`
		const writeArg = (l1.wallet.writeContract.mock.calls[0] as unknown[])[0] as {
			args: [{ aztecRecipient: string; tokenSecretHash: string }]
		}
		// R is NOT on-chain (a real value leaks via the router's indexed BridgeWithFuel event)…
		expect(writeArg.args[0].aztecRecipient).toBe(ZERO32)
		expect(writeArg.args[0].aztecRecipient).not.toBe(AZTEC_RECIPIENT)
		// …but the commitment STILL binds the real recipient, so claim_private re-derives + mints to R.
		expect(writeArg.args[0].tokenSecretHash).toBe((await tokenClaimSecretHash(baseParams.tokenClaimSalt, claimer)).toString())
		// The signed witness matches the calldata (else the Permit2 signature wouldn't verify).
		const typed = (l1.wallet.signTypedData.mock.calls[0] as unknown[])[0] as { message: { witness: { aztecRecipient: string } } }
		expect(typed.message.witness.aztecRecipient).toBe(ZERO32)
	})

	it("PUBLIC deposit still passes the real aztecRecipient on-chain (recipient bound in the content hash)", async () => {
		const l1 = makeL1()
		await runSwapBridge(l1 as never, { ...baseParams, isPrivate: false } as never)
		const writeArg = (l1.wallet.writeContract.mock.calls[0] as unknown[])[0] as { args: [{ aztecRecipient: string }] }
		expect(writeArg.args[0].aztecRecipient).toBe(AZTEC_RECIPIENT)
	})

	// A nonzero-but-invalid recipient strands the deposit (an undecryptable note the
	// commitment makes unrecoverable). 0x..03 is canonical + nonzero but NOT a Grumpkin point.
	it("rejects a nonzero-but-invalid recipient (not a Grumpkin point) BEFORE signing", async () => {
		const l1 = makeL1()
		const injected = deriveBridgeSecret(Fr.zero(), AztecAddress.fromStringUnsafe(AZTEC_RECIPIENT))
		// RECIPIENT (0x..03) is canonical + nonzero but NOT a Grumpkin point (isValid() === false).
		await expect(
			runSwapBridge(l1 as never, { ...baseParams, aztecRecipient: RECIPIENT, fuelSecret: injected } as never),
		).rejects.toThrow(/not a valid Aztec address/)
		expect(l1.wallet.signTypedData).not.toHaveBeenCalled()
	})

	it("private token leg with no tokenClaimSalt is rejected BEFORE signing", async () => {
		const l1 = makeL1()
		const injected = deriveBridgeSecret(Fr.zero(), AztecAddress.fromStringUnsafe(AZTEC_RECIPIENT))
		// fuelSecret present (passes the fuel guard) but tokenClaimSalt omitted → a random token secret
		// would strand the deposit against the recipient-committed claim_private.
		const { tokenClaimSalt: _drop, ...noSalt } = baseParams
		await expect(runSwapBridge(l1 as never, { ...noSalt, fuelSecret: injected } as never)).rejects.toThrow(
			/private token leg requires an injected tokenClaimSalt/,
		)
		expect(l1.wallet.signTypedData).not.toHaveBeenCalled()
	})

	it("falls back to a random secret when none is injected (PUBLIC path unchanged)", async () => {
		const l1 = makeL1()
		const res = await runSwapBridge(l1 as never, { ...baseParams, isPrivate: false } as never)
		expect(res.fuelSecretHex).toMatch(/^0x[0-9a-f]{64}$/)
		expect(res.tokenSecretHex).not.toBe(res.fuelSecretHex) // token still random, distinct from fuel
	})

	it("F-005: private fuel with no injected secret is rejected BEFORE signing", async () => {
		const l1 = makeL1()
		// isPrivate (baseParams) + no fuelSecret: the silent Fr.random() fallback would strand the FJ.
		await expect(runSwapBridge(l1 as never, { ...baseParams } as never)).rejects.toThrow(/private fuel requires an injected fuelSecret/)
		expect(l1.wallet.signTypedData).not.toHaveBeenCalled()
	})

	it("F-005: private fuel to a non-FPC recipient is rejected BEFORE signing", async () => {
		const l1 = makeL1()
		const injected = deriveBridgeSecret(Fr.zero(), AztecAddress.fromStringUnsafe(AZTEC_RECIPIENT))
		const evil = `0x${"de".repeat(32)}` as `0x${string}`
		await expect(runSwapBridge(l1 as never, { ...baseParams, fuelSecret: injected, fuelRecipient: evil } as never)).rejects.toThrow(
			/must target the PrivateFPC/,
		)
		expect(l1.wallet.signTypedData).not.toHaveBeenCalled()
	})
})
