// The Bridge tab shares the Drip tab's Aztec session - same origin = same app to the wallet, and one
// combined manifest (capabilities.ts `buildCombinedManifest`) covers both tabs' contracts + scopes.
// Re-exported under the bridge name so the bridge components/composables keep their import path while
// the connection + grant are shared: connecting on the Drip tab means no re-connect on the Bridge.
export {
	useWalletConnection as useBridgeWallet,
	__resetWalletConnectionForTests as __resetBridgeWalletForTests,
} from "./useWalletConnection"
