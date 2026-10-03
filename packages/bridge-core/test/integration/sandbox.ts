/** Per-file access to the booted sandbox: connected clients once per file, a FRESH actor per
 *  context so no test inherits another's balances, notes or registrations. */
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { inject } from "vitest"
import type { ManifestToken, ManifestV2 } from "../../src/manifest-v2"
import { buildContext, type SmokeContext, tokenBlockOf } from "../../scripts/sandbox/context"
import { openSandbox, readManifest, type SandboxClients } from "../../scripts/sandbox/handle"
import { type Actor, createActor, freshActorSecret } from "../../scripts/sandbox/l2"

export const INTEGRATION = Boolean(process.env.BRIDGE_INTEGRATION)

export interface Sandbox {
	clients: SandboxClients
	manifest: ManifestV2
	usdc: ManifestToken
	usdt: ManifestToken
	pxo: ManifestToken
}

let cached: Promise<Sandbox> | undefined

export function sandbox(): Promise<Sandbox> {
	cached ??= (async () => {
		const handle = inject("handle")
		const clients = await openSandbox(handle)
		const manifest = readManifest(handle.artifactsDir)
		const [usdc, usdt, pxo] = manifest.bridge?.tokens ?? []
		if (!usdc || !usdt || !pxo) throw new Error("the sandbox manifest lists fewer than three tokens")
		return { clients, manifest, usdc, usdt, pxo }
	})()
	return cached
}

export interface ActorContext {
	actor: Actor
	s: SmokeContext
	l2TokenOf: (t: ManifestToken) => Promise<ContractBase>
}

/** A brand-new account of the shape the Nulo wallet deploys, sponsor-deployed, with its own context. */
export async function freshActor(): Promise<ActorContext> {
	const { clients, manifest } = await sandbox()
	const actor = await createActor(clients.l2.wallet, clients.l2.node, clients.l2.fee, freshActorSecret(), 1n, () => {})
	const s = await buildContext(clients, manifest, actor.address)
	return { actor, s, l2TokenOf: (t) => s.l2TokenOf(tokenBlockOf(t)) }
}
