/**
 * The alias a testnet preview is uploaded under. A testnet build of a non-production branch goes up
 * as a Workers version and is served at `<alias>-<worker>.<subdomain>.workers.dev`, the workers.dev
 * host with `<alias>-` in front, as well as at its per-version URL. Never on mainnet or the
 * production branch.
 *
 * Node-only (`node:crypto`): scripts/upload-preview.ts imports it, the app does not.
 */
import { createHash } from "node:crypto"

export const PRODUCTION_BRANCH = "main"

const DNS_LABEL_MAX = 63

/** The Worker name a `<worker>.<subdomain>.workers.dev` host is served by. */
export function workerOf(host: string): string {
	const labels = host.split(".")
	if (labels.length !== 4 || labels.slice(2).join(".") !== "workers.dev") {
		throw new Error(`preview hosts need a <worker>.<subdomain>.workers.dev host, not '${host}'`)
	}
	return labels[0]
}

/**
 * `p-<first 32 hex of sha256(branch)>-<slug>`. The hash keeps apart two branches that truncate to one
 * slug, and at 128 bits nobody can craft a second branch that lands on a preview's alias (32 bits
 * fell to a birthday search); the `p-` keeps the label from starting with a digit; the slug is cut
 * so `<alias>-<worker>` fits one DNS label.
 */
export function previewAlias(branch: string, worker: string): string {
	const base = `p-${createHash("sha256").update(branch).digest("hex").slice(0, 32)}`
	const room = DNS_LABEL_MAX - worker.length - base.length - 2
	const slug = branch
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, Math.max(0, room))
		.replace(/-+$/g, "")
	const alias = slug ? `${base}-${slug}` : base
	if (`${alias}-${worker}`.length > DNS_LABEL_MAX) throw new Error(`worker name ${worker} leaves no room for a preview alias`)
	return alias
}
