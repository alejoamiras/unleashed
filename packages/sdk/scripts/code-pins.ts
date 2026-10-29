/**
 * Writes `src/protocol/code-pins.json` from the forge build in `contracts/bridge/evm/out`. Run after any change to a
 * pinned contract's source or compiler settings; `code-pins.test.ts` fails until the pins match the build again.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { hexToBytes } from "viem"
import { type CodePin, type ImmutableSpan, type PinnedContract, pinOfBuild } from "../src/protocol/code-hash.ts"

const here = dirname(fileURLToPath(import.meta.url))
export const FORGE_OUT = join(here, "..", "..", "..", "contracts", "bridge", "evm", "out")
export const PINNED: readonly PinnedContract[] = ["DepositRouter", "PortalFactory", "TokenPortalImpl", "FuelOnlyGate", "TestnetFuelSwapper"]

interface ForgeArtifact {
	deployedBytecode?: { object?: `0x${string}`; immutableReferences?: Record<string, ImmutableSpan[]> }
}

/** The pin of one contract's forge artifact; throws when the artifact carries no runtime. */
export function buildPin(contract: PinnedContract, out = FORGE_OUT): CodePin {
	const artifact = JSON.parse(readFileSync(join(out, `${contract}.sol`, `${contract}.json`), "utf8")) as ForgeArtifact
	const object = artifact.deployedBytecode?.object
	if (!object || object === "0x") throw new Error(`${contract}: the artifact carries no deployedBytecode`)
	return pinOfBuild(hexToBytes(object), artifact.deployedBytecode?.immutableReferences)
}

if (import.meta.main) {
	const pins = Object.fromEntries(PINNED.map((c) => [c, buildPin(c)]))
	writeFileSync(join(here, "..", "src", "protocol", "code-pins.json"), `${JSON.stringify(pins, null, "\t")}\n`)
	console.log(`pinned ${PINNED.join(", ")}`)
}
