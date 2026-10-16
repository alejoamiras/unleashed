/**
 * The three FeeAssetHandler functions the testnet mint calls. The published `FeeAssetHandlerAbi`
 * carries every rollup error (about 300 entries), so the bundle takes only these, pinned to it by test.
 */
export const FEE_ASSET_HANDLER_ABI = [
	{ type: "function", name: "FEE_ASSET", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
	{ type: "function", name: "mintAmount", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
	{
		type: "function",
		name: "mint",
		stateMutability: "nonpayable",
		inputs: [{ name: "_recipient", type: "address" }],
		outputs: [],
	},
] as const
