/**
 * The Node side of a browser test: the same harness the integration suite drives, attached to the
 * sandbox the runner booted. Actors are created (and sponsor-deployed) HERE, before the wallet in
 * the browser ever hears their seeds, so a fixture can fund an account the UI has not shown yet.
 */
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import type { ManifestToken, ManifestV2 } from "@unleashed/bridge-core"
import {
	type Actor,
	buildContext,
	createActor,
	freshActorSecret,
	openSandbox,
	readHandle,
	readManifest,
	type SandboxClients,
	type SmokeContext,
	tokenBlockOf,
} from "@unleashed/bridge-core/sandbox"
import { runEnv } from "../env"
import type { Seed } from "../test-wallet/profile"

export interface SandboxAccess {
	clients: SandboxClients
	manifest: ManifestV2
	tokens: { usdc: ManifestToken; usdt: ManifestToken; pxo: ManifestToken }
	/** A brand-new account of the shape the Nulo wallet deploys, deployed through the sponsor, with its own flow context. */
	newActor(): Promise<ActorHandle>
}

export interface ActorHandle {
	actor: Actor
	seed: Seed
	address: string
	s: SmokeContext
	l2TokenOf(t: ManifestToken): Promise<ContractBase>
}

let cached: Promise<SandboxAccess> | undefined

/** Connected once per worker process; the embedded scripting wallet inside is expensive to open. */
export function sandboxAccess(): Promise<SandboxAccess> {
	cached ??= (async () => {
		const env = runEnv()
		const handle = readHandle(env.artifactsDir)
		const clients = await openSandbox(handle)
		const manifest = readManifest(env.artifactsDir)
		const [usdc, usdt, pxo] = manifest.bridge?.tokens ?? []
		if (!usdc || !usdt || !pxo) throw new Error("the sandbox manifest lists fewer than three tokens")
		return {
			clients,
			manifest,
			tokens: { usdc, usdt, pxo },
			async newActor() {
				const secret = freshActorSecret()
				const actor = await createActor(clients.l2.wallet, clients.l2.node, clients.l2.fee, secret, 1n, () => {})
				const s = await buildContext(clients, manifest, actor.address)
				return {
					actor,
					seed: { secret, salt: actor.salt.toString() },
					address: actor.address.toString(),
					s,
					l2TokenOf: (t) => s.l2TokenOf(tokenBlockOf(t)),
				}
			},
		}
	})()
	return cached
}
