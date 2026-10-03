/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_AZTEC_NODE_URL?: string
	readonly VITE_EXPLORER_BASE_URL?: string
	readonly VITE_WALLET_INSTALL_URL?: string
	/** The active build target, `define`d by vite.<target>.config.mts (unset ⇒ testnet fallback). */
	readonly VITE_TOOLS_TARGET?: "testnet" | "mainnet"
	/** The per-target bridge manifest JSON, `define`d at build (unset ⇒ static testnet import). */
	readonly VITE_BRIDGE_MANIFEST_JSON?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

declare module "*.vue" {
	import type { DefineComponent } from "vue"
	const component: DefineComponent<object, object, unknown>
	export default component
}
