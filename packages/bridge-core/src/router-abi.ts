/**
 * Minimal SwapBridgeRouter ABI for browser callers (the tools app can't read forge artifacts at
 * runtime). Hand-written and PINNED against the forge artifact by router-abi.test.ts — any
 * drift between this const and the compiled router fails the suite.
 */
export const SWAP_BRIDGE_ROUTER_ABI = [
	{
		type: "function",
		name: "bridgeWithFuel",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "p",
				type: "tuple",
				components: [
					{ name: "tokenPortal", type: "address" },
					{ name: "bridgeToken", type: "address" },
					{ name: "totalAmount", type: "uint256" },
					{ name: "fuelAmount", type: "uint256" },
					{ name: "aztecRecipient", type: "bytes32" },
					{ name: "fuelRecipient", type: "bytes32" },
					{ name: "tokenSecretHash", type: "bytes32" },
					{ name: "fuelSecretHash", type: "bytes32" },
					{ name: "minFuelOutput", type: "uint256" },
					{
						name: "path",
						type: "tuple[]",
						components: [
							{ name: "currency0", type: "address" },
							{ name: "currency1", type: "address" },
							{ name: "fee", type: "uint24" },
							{ name: "tickSpacing", type: "int24" },
							{ name: "hooks", type: "address" },
						],
					},
					{ name: "zeroForOnes", type: "bool[]" },
					{ name: "isPrivate", type: "bool" },
				],
			},
			{
				name: "permit",
				type: "tuple",
				components: [
					{ name: "nonce", type: "uint256" },
					{ name: "deadline", type: "uint256" },
					{ name: "signature", type: "bytes" },
				],
			},
		],
		outputs: [],
	},
	{
		type: "event",
		name: "BridgeWithFuel",
		inputs: [
			{ name: "aztecRecipient", type: "bytes32", indexed: true },
			{ name: "tokenKey", type: "bytes32", indexed: false },
			{ name: "tokenIndex", type: "uint256", indexed: false },
			{ name: "tokenAmount", type: "uint256", indexed: false },
			{ name: "tokenSecretHash", type: "bytes32", indexed: false },
			{ name: "fuelKey", type: "bytes32", indexed: false },
			{ name: "fuelIndex", type: "uint256", indexed: false },
			{ name: "fuelAmount", type: "uint256", indexed: false },
			{ name: "fuelSecretHash", type: "bytes32", indexed: false },
			{ name: "isPrivate", type: "bool", indexed: false },
		],
	},
	// bridge-only, plus direct gas for the fee asset (tokenPortal = FeeJuicePortal, public only).
	{
		type: "function",
		name: "bridge",
		stateMutability: "nonpayable",
		inputs: [
			{
				name: "p",
				type: "tuple",
				components: [
					{ name: "tokenPortal", type: "address" },
					{ name: "bridgeToken", type: "address" },
					{ name: "amount", type: "uint256" },
					{ name: "aztecRecipient", type: "bytes32" },
					{ name: "secretHash", type: "bytes32" },
					{ name: "isPrivate", type: "bool" },
				],
			},
			{
				name: "permit",
				type: "tuple",
				components: [
					{ name: "nonce", type: "uint256" },
					{ name: "deadline", type: "uint256" },
					{ name: "signature", type: "bytes" },
				],
			},
		],
		outputs: [],
	},
	{
		type: "event",
		name: "Bridge",
		inputs: [
			{ name: "aztecRecipient", type: "bytes32", indexed: true },
			{ name: "key", type: "bytes32", indexed: false },
			{ name: "index", type: "uint256", indexed: false },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "secretHash", type: "bytes32", indexed: false },
			{ name: "isPrivate", type: "bool", indexed: false },
		],
	},
	// Cross-binding readbacks: the router's factory and fee asset must match the manifest's.
	{ type: "function", name: "FACTORY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "FEE_ASSET", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "feeJuicePortal", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "swapTarget", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	// The router's own refusals, decoded for the wizard's error copy.
	{ type: "error", name: "ForeignPortal", inputs: [] },
	{ type: "error", name: "FuelOnlyLeg", inputs: [] },
	{ type: "error", name: "RouteRequired", inputs: [] },
	{ type: "error", name: "AmountExceedsL2Max", inputs: [] },
	// A fee-on-transfer token trips this on the Permit2 pull — the likeliest arbitrary-token refusal.
	{ type: "error", name: "InexactPull", inputs: [] },
] as const
