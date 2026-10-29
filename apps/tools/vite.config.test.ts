// @vitest-environment node
import { bundledManifest } from "@unleashed/sdk/networks"
import { describe, expect, it } from "vitest"
import { MAINNET_TARGET, TESTNET_TARGET } from "./src/lib/network-targets"
import { makeToolsConfig } from "./vite.config"

describe("makeToolsConfig", () => {
	it.each([TESTNET_TARGET, MAINNET_TARGET])("the $key build inlines the SDK's bundled manifest", (target) => {
		const define = makeToolsConfig(target).define as Record<string, string>
		const inlined = JSON.parse(JSON.parse(define["import.meta.env.VITE_BRIDGE_MANIFEST_JSON"] as string))
		expect(inlined).toEqual(bundledManifest(target.l1ChainId))
	})
})
