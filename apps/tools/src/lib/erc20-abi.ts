/**
 * The permissionless `mint` the testnet token contracts expose. Deliberately NOT part of
 * `@unleashed/bridge-core`'s `ERC20_ABI`: that one is the surface the bridge reads on ANY ERC-20, and a
 * mint entry there would invite calling it on a token that has none.
 */
export const MINTABLE_ERC20_ABI = [
	{
		type: "function",
		name: "mint",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [],
	},
] as const
