/**
 * Minimal DepositRouter ABI for browser callers (the tools app can't read forge artifacts at runtime).
 * Hand-written and PINNED against the forge artifact by deposit-router-abi.test.ts: any drift between
 * this const and the compiled router fails the suite.
 */

/** `DepositRouter.DepositIntent`, field for field. */
export const DEPOSIT_INTENT_COMPONENTS = [
	{ name: "token", type: "address" },
	{ name: "aztecRecipient", type: "bytes32" },
	{ name: "tokenSecretHash", type: "bytes32" },
	{ name: "isPrivate", type: "bool" },
	{ name: "fuelSlice", type: "uint256" },
	{ name: "fuelRecipient", type: "bytes32" },
	{ name: "fuelSecretHash", type: "bytes32" },
	{ name: "minFuelOutput", type: "uint256" },
] as const

/** `DepositRouter.PermitParams`, field for field. */
export const PERMIT_PARAMS_COMPONENTS = [
	{ name: "nonce", type: "uint256" },
	{ name: "deadline", type: "uint256" },
	{ name: "signature", type: "bytes" },
] as const

const INTENT = { name: "intent", type: "tuple", components: DEPOSIT_INTENT_COMPONENTS } as const
const SETTLED = [
	{ name: "tokenAmount", type: "uint256" },
	{ name: "fuelOut", type: "uint256" },
] as const

const readback = <const N extends string, const T extends "address" | "bytes32" | "string">(name: N, type: T) =>
	({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type }] }) as const

const error = <const N extends string>(name: N) => ({ type: "error", name, inputs: [] }) as const

export const DEPOSIT_ROUTER_ABI = [
	{
		type: "function",
		name: "bridgeWithPermit",
		stateMutability: "nonpayable",
		inputs: [
			INTENT,
			{ name: "swapData", type: "bytes" },
			{ name: "amount", type: "uint256" },
			{ name: "permit", type: "tuple", components: PERMIT_PARAMS_COMPONENTS },
		],
		outputs: SETTLED,
	},
	{
		type: "function",
		name: "bridgeFromCaller",
		stateMutability: "nonpayable",
		inputs: [
			INTENT,
			{ name: "swapData", type: "bytes" },
			{ name: "minReceived", type: "uint256" },
			{ name: "maxPull", type: "uint256" },
		],
		outputs: SETTLED,
	},
	// The Permit2 witness's EIP-712 struct hash, for checking a client-built witness against the deployed router.
	{
		type: "function",
		name: "hashWitness",
		stateMutability: "pure",
		inputs: [INTENT, { name: "swapData", type: "bytes" }],
		outputs: [{ name: "", type: "bytes32" }],
	},
	{
		type: "event",
		name: "Deposited",
		anonymous: false,
		inputs: [
			{ name: "tokenSecretHash", type: "bytes32", indexed: true },
			{ name: "fuelSecretHash", type: "bytes32", indexed: true },
			{ name: "token", type: "address", indexed: true },
			{ name: "payer", type: "address", indexed: false },
			{ name: "received", type: "uint256", indexed: false },
			{ name: "tokenAmount", type: "uint256", indexed: false },
			{ name: "tokenKey", type: "bytes32", indexed: false },
			{ name: "tokenIndex", type: "uint256", indexed: false },
			{ name: "fuelIn", type: "uint256", indexed: false },
			{ name: "fuelOut", type: "uint256", indexed: false },
			{ name: "fuelKey", type: "bytes32", indexed: false },
			{ name: "fuelIndex", type: "uint256", indexed: false },
			{ name: "isPrivate", type: "bool", indexed: false },
		],
	},
	readback("DEPOSIT_WITNESS_TYPE_STRING", "string"),
	readback("DEPOSIT_WITNESS_TYPEHASH", "bytes32"),
	// Cross-binding readbacks: each must match the manifest's generation.
	readback("PERMIT2", "address"),
	readback("FEE_JUICE_PORTAL", "address"),
	readback("FACTORY", "address"),
	readback("FEE_ASSET", "address"),
	readback("SWAP_TARGET", "address"),
	// Every revert the router itself can raise, inherited ones included, so a client decodes all of them.
	error("ZeroAddress"),
	error("NotAContract"),
	error("DepositsPaused"),
	error("FuelOnlyShape"),
	error("PrivateWithRecipient"),
	error("FuelFieldsWithoutSlice"),
	error("IdentityWithSwapData"),
	error("SwapDataTooShort"),
	error("UnpinnedSelector"),
	error("ForeignReceiver"),
	error("ZeroFuelFloor"),
	error("SliceOutOfBounds"),
	error("BadBounds"),
	error("BelowMinimum"),
	error("InexactPull"),
	error("LeftoverExceedsPull"),
	error("InexactFuelConsumption"),
	error("InsufficientFuel"),
	error("ReentrancyGuardReentrantCall"),
	{ type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
	{ type: "error", name: "OwnableUnauthorizedAccount", inputs: [{ name: "account", type: "address" }] },
	{ type: "error", name: "OwnableInvalidOwner", inputs: [{ name: "owner", type: "address" }] },
] as const
