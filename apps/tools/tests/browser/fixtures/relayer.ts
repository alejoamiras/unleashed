/**
 * The cross-chain half of the sandbox as a spec drives it: the relay loop `sandbox:up` runs for the whole run (steered
 * through its loopback API, one mode for the next deposit it sees), the source anvil's clock, and the Ethereum clock a
 * deposit's fill deadline is measured against.
 *
 * The two anvils keep different clocks: the local network warps Ethereum's to each L2 block's slot, so it runs hours
 * ahead of the source chain's wall-clock time. A fixed-terms deposit's deadline is the source head plus the fill
 * window, so the source clock is brought level with Ethereum's before a route is quoted, as two live chains are.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
	ARTIFACT_FILES,
	type CrossChainClients,
	type l2CtxFor,
	openCrossChain,
	type RelayMode,
	type SandboxHandle,
} from "@unleashed/bridge-core/sandbox"
import { toHex } from "viem"

export interface RelayerControl {
	cc: CrossChainClients
	/** How the shared loop treats each deposit it first sees from now on; the fixture puts it back to `now`. */
	setMode(mode: RelayMode): Promise<void>
	/** Mines a source block at Ethereum's latest timestamp, unless the source chain is already there. */
	syncSourceClock(): Promise<void>
	/** Forces L2 blocks, each of which warps Ethereum to its slot, until a finalized Ethereum block is past `deadline`. */
	passOnEthereum(deadline: number): Promise<void>
}

export function relayApiUrl(artifactsDir: string): string {
	return (JSON.parse(readFileSync(join(artifactsDir, ARTIFACT_FILES.relayApi), "utf8")) as { url: string }).url
}

export function relayerControl(handle: SandboxHandle, artifactsDir: string, l2: ReturnType<typeof l2CtxFor>): RelayerControl {
	const cc = openCrossChain(handle)
	const api = relayApiUrl(artifactsDir)
	const source = cc.source.pub
	const ethereum = cc.l1.pub
	return {
		cc,
		async setMode(mode) {
			const res = await fetch(`${api}/relayer/mode`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(mode),
			})
			if (res.status !== 204) throw new Error(`the relay API refused mode ${mode.kind}: ${res.status} ${await res.text()}`)
		},
		async syncSourceClock() {
			const [eth, src] = await Promise.all([ethereum.getBlock(), source.getBlock()])
			if (src.timestamp >= eth.timestamp) return
			await source.request({ method: "evm_setNextBlockTimestamp", params: [toHex(eth.timestamp)] } as never)
			await source.request({ method: "evm_mine", params: [] } as never)
		},
		async passOnEthereum(deadline) {
			for (let i = 0; i < 400; i++) {
				const finalized = await ethereum.getBlock({ blockTag: "finalized" })
				if (finalized.timestamp > BigInt(deadline)) return
				await l2.forceBlock?.()
			}
			throw new Error(`Ethereum's finalized clock did not pass ${deadline} within 400 forced blocks`)
		},
	}
}
