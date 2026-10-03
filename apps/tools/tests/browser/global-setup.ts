/**
 * Proves the run is coherent before a browser opens: the handle names the sandbox the builds were
 * made for, and the faucet record the sandbox deployed is the one the app commits (universal
 * deploys — deployer ZERO, fixed salts — so the addresses are the same on every chain).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { readHandle } from "@unleashed/bridge-core/sandbox"
import { runEnv } from "./env"

/** Key order made irrelevant at EVERY depth (a replacer array would whitelist the root's keys
 *  recursively and empty every nested object — two different records would compare equal). */
function canonical(json: string): string {
	const sortKeys = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(sortKeys)
		if (v && typeof v === "object") {
			return Object.fromEntries(
				Object.keys(v as Record<string, unknown>)
					.sort()
					.map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
			)
		}
		return v
	}
	return JSON.stringify(sortKeys(JSON.parse(json)))
}

export default function globalSetup(): void {
	const env = runEnv()
	const handle = readHandle(env.artifactsDir)
	if (handle.l1ChainId !== 31337) throw new Error(`the sandbox handle names L1 chain ${handle.l1ChainId}, expected 31337`)
	const build = JSON.parse(readFileSync(join(env.toolsDist, "build.json"), "utf8")) as { target?: string; chainId?: number }
	if (build.target !== "local" || build.chainId !== handle.walletChainId) {
		throw new Error(`the tools build in ${env.toolsDist} is ${build.target}/${build.chainId}, not local/${handle.walletChainId}`)
	}
	const committed = readFileSync(new URL("../../src/contracts/deployments.json", import.meta.url), "utf8")
	const deployed = readFileSync(join(env.artifactsDir, "deployments.json"), "utf8")
	if (canonical(committed) !== canonical(deployed)) {
		throw new Error(
			"the sandbox's deployments.json differs from apps/tools/src/contracts/deployments.json — the drip record is no longer universal",
		)
	}
}
