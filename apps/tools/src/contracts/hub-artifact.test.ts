// @vitest-environment node
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { codeOf, parseManifestV2 } from "@unleashed/sdk/protocol"
import { describe, expect, it, vi } from "vitest"
import { hubArtifact } from "./bridge-generation"

// This build's hub target, standing in for one a source edit moved: the testnet build must not load it.
vi.mock("@unleashed/sdk/artifacts", () => ({ tokenBridgeHubArtifact: { name: "TokenBridgeHubAtHead" } }))

const SANDBOX = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"packages",
	"bridge-core",
	"fixtures",
	"sandbox-manifest.json",
)

describe("the hub artifact the testnet build registers and calls", () => {
	it("is the testnet generation's kept artifact, never this build's hub target", async () => {
		expect((await hubArtifact()).name).toBe("TokenBridgeHub")
		// The stand-in is what a sandbox build loads, through the same selector.
		const sandbox = parseManifestV2(JSON.parse(readFileSync(SANDBOX, "utf8")))
		expect((await codeOf(sandbox).hubArtifact()).name).toBe("TokenBridgeHubAtHead")
	})
})
