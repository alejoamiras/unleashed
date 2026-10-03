/**
 * Minimal PortalFactory + portal-clone ABIs for browser callers (the faucet can't read forge
 * artifacts at runtime). Hand-written and PINNED against the forge artifacts by
 * factory-abi.test.ts — any drift between these consts and the compiled contracts fails the suite.
 */

const REGISTRATION_COMPONENTS = [
	{ name: "portal", type: "address" },
	{ name: "decimals", type: "uint8" },
	{ name: "registerIndex", type: "uint64" },
	{ name: "nameWord", type: "bytes32" },
	{ name: "symbolWord", type: "bytes32" },
	{ name: "registerKey", type: "bytes32" },
] as const

export const PORTAL_FACTORY_ABI = [
	{
		type: "function",
		name: "createPortal",
		stateMutability: "nonpayable",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "portal", type: "address" }],
	},
	{
		type: "function",
		name: "predictPortal",
		stateMutability: "view",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "portalOf",
		stateMutability: "view",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "", type: "address" }],
	},
	{
		type: "function",
		name: "tokenOf",
		stateMutability: "view",
		inputs: [{ name: "portal", type: "address" }],
		outputs: [{ name: "token", type: "address" }],
	},
	{
		type: "function",
		name: "registrationOf",
		stateMutability: "view",
		inputs: [{ name: "token", type: "address" }],
		outputs: [{ name: "", type: "tuple", components: REGISTRATION_COMPONENTS }],
	},
	{ type: "function", name: "depositsPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
	{ type: "function", name: "withdrawsPaused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
	{ type: "function", name: "IMPLEMENTATION", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "L2_HUB", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bytes32" }] },
	{
		type: "event",
		name: "PortalCreated",
		inputs: [
			{ name: "token", type: "address", indexed: true },
			{ name: "portal", type: "address", indexed: true },
			{ name: "nameWord", type: "bytes32", indexed: false },
			{ name: "symbolWord", type: "bytes32", indexed: false },
			{ name: "decimals", type: "uint8", indexed: false },
			{ name: "registerKey", type: "bytes32", indexed: false },
			{ name: "registerIndex", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "PauseChanged",
		inputs: [
			{ name: "deposits", type: "bool", indexed: false },
			{ name: "withdraws", type: "bool", indexed: false },
		],
	},
	{ type: "error", name: "NotAContract", inputs: [] },
	{ type: "error", name: "NoDecimals", inputs: [] },
] as const

export const TOKEN_PORTAL_ABI = [
	{
		type: "function",
		name: "depositToAztecPublic",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_to", type: "bytes32" },
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHash", type: "bytes32" },
		],
		outputs: [
			{ name: "", type: "bytes32" },
			{ name: "", type: "uint256" },
		],
	},
	{
		type: "function",
		name: "depositToAztecPrivate",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_amount", type: "uint256" },
			{ name: "_secretHashForL2MessageConsumption", type: "bytes32" },
		],
		outputs: [
			{ name: "", type: "bytes32" },
			{ name: "", type: "uint256" },
		],
	},
	{
		type: "function",
		name: "withdraw",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "_recipient", type: "address" },
			{ name: "_amount", type: "uint256" },
			{ name: "_withCaller", type: "bool" },
			{ name: "_epoch", type: "uint256" },
			{ name: "_numCheckpointsInEpoch", type: "uint256" },
			{ name: "_leafIndex", type: "uint256" },
			{ name: "_path", type: "bytes32[]" },
		],
		outputs: [],
	},
	{ type: "function", name: "underlying", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "FACTORY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{
		type: "event",
		name: "DepositToAztecPublic",
		inputs: [
			{ name: "to", type: "bytes32", indexed: false },
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "secretHash", type: "bytes32", indexed: false },
			{ name: "key", type: "bytes32", indexed: false },
			{ name: "index", type: "uint256", indexed: false },
		],
	},
	{
		type: "event",
		name: "DepositToAztecPrivate",
		inputs: [
			{ name: "amount", type: "uint256", indexed: false },
			{ name: "secretHashForL2MessageConsumption", type: "bytes32", indexed: false },
			{ name: "key", type: "bytes32", indexed: false },
			{ name: "index", type: "uint256", indexed: false },
		],
	},
	{ type: "error", name: "DepositsPaused", inputs: [] },
	{ type: "error", name: "WithdrawsPaused", inputs: [] },
	{ type: "error", name: "AmountExceedsL2Max", inputs: [] },
	{ type: "error", name: "InexactTransfer", inputs: [] },
	{ type: "error", name: "ImplementationOnly", inputs: [] },
] as const
