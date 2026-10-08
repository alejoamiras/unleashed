/**
 * Relayer: finish a user's stuck L1→L2 deposit by submitting the hub claim FOR them, on live testnet.
 *
 * The private claim is recipient-committed — the circuit re-derives the consumption secret from
 * `(salt, recipient)` — so a relayer can complete a deposit and can never redirect it. The pure
 * key-handling + descriptor validation lives in `../src/relay-claim.ts` (unit-tested); this file is
 * only the live wiring (node, sponsored-FPC wallet, hub registration, the send).
 *
 * Usage:
 *   RELAYER_L2_SECRET_KEY=0x…  bun run scripts/relay-claim-testnet.ts --claim ./claim.json \
 *     [--config apps/tools/public/testnet-bridge.json] [--token 0x…] [--public] \
 *     [--register-index <n>] [--wrong-recipient]
 * where claim.json is the off-chain hand-off from the user:
 *   { "bridge": "0x…hub", "recipient": "0x…", "amount": "1000", "salt": "0x…", "leafIndex": 7 }
 *
 * `--token` selects which manifest ERC-20 the claim belongs to (default: the first). `--public`
 * treats `salt` as the raw public claim secret instead of the private claim salt. `--register-index`
 * is needed only when the hub has not registered the token yet — the deposit's factory `register`
 * leaf, from the sender's journal record or the factory's `registrationOf`.
 *
 * Security: the relayer runs under its OWN dedicated key (RELAYER_L2_SECRET_KEY), never the user's.
 * The `salt` is a linkage-privacy credential the relayer necessarily learns; it is NEVER logged
 * (only a redacted view is printed).
 */
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { claimViaHub, type HubClaimParams } from "../src/hub-l2"
import type { JournalTokenBlock } from "../src/journal"
import type { SendOpts } from "../src/hub-l2"
import { type ManifestToken, type ManifestV2, manifestToken } from "../src/manifest-v2"
import { parseClaimDescriptor, type RelayClaimDescriptor, redactDescriptorForLog, requireRelayerSecret } from "../src/relay-claim"
import { createL2Wallet, createNode, loadManifestV2FromConfigArg, requireBridge } from "./script-bootstrap"
import { claimTokensUntilSynced, deployAccountIfAbsent, registerHub, registerHubToken, sponsoredFpcFee } from "./script-l2"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL

const here = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = process.env.BRIDGE_MANIFEST ?? join(here, "..", "..", "..", "apps", "tools", "public", "testnet-bridge.json")

function flagValue(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag)
	return i >= 0 ? argv[i + 1] : undefined
}

function claimPathFromArgv(argv: string[]): string {
	const path = flagValue(argv, "--claim") ?? process.env.RELAY_CLAIM_FILE
	if (!path) throw new Error("missing --claim <file> (or RELAY_CLAIM_FILE)")
	return isAbsolute(path) ? path : join(process.cwd(), path)
}

/** The claim's token facts, from the manifest plus the register leaf a first-ever claim consumes. */
function tokenBlock(token: ManifestToken, registerIndex?: string): JournalTokenBlock {
	return {
		erc20: token.erc20,
		portal: token.portal,
		l2Token: token.l2Token,
		nameWord: token.nameWord,
		symbolWord: token.symbolWord,
		decimals: token.decimals,
		displaySymbol: token.displaySymbol,
		registerIndex,
	}
}

/**
 * The relayer's own account: a FIXED account salt makes its address deterministic across runs, and
 * the sponsored FPC means it never needs Fee Juice of its own.
 */
async function relayerWallet(secret: Fr) {
	const node = createNode(NODE_URL)
	const ewallet = await createL2Wallet({ nodeUrl: NODE_URL, proverEnabled: true })
	const { signingKey, secretKey } = await deriveNuloAccountKeys(secret)
	const manager = await ewallet.createSchnorrAccount(secretKey, Fr.ZERO, signingKey)
	const from = (await manager.getAccount()).getAddress()
	const { fee } = await sponsoredFpcFee(ewallet)
	await deployAccountIfAbsent({
		node,
		manager: manager as never,
		from,
		fee,
		log: (stage) => {
			if (stage === "deploying") console.log("deploying the relayer account (real proof, ~minutes)…")
		},
	})
	return { ewallet, from, sendOpts: { from, fee, wait: { waitForStatus: TxStatus.PROPOSED } } }
}

/**
 * Prove the circuit's recipient binding live: the same salt, amount and leaf under the RELAYER's own
 * address derives a different consumption secret, so the claim cannot consume the message. A success
 * here would mean a relayer can redirect a user's funds.
 */
async function runRedirectCanary(hub: ContractBase, claim: HubClaimParams, relayer: string, sendOpts: SendOpts): Promise<void> {
	if (relayer.toLowerCase() === claim.recipient.toLowerCase()) {
		throw new Error(
			"--wrong-recipient: the relayer IS the bound recipient — use a relayer key that differs so the wrong claim is wrong",
		)
	}
	console.log(`[canary] claiming with the WRONG recipient ${relayer} — this MUST revert`)
	let reverted = false
	try {
		await claimViaHub(hub, { ...claim, recipient: relayer }, sendOpts)
	} catch {
		reverted = true
	}
	if (!reverted)
		throw new Error("SECURITY FAILURE: a wrong-recipient claim SUCCEEDED — recipient-commitment is broken (redirect possible)")
	console.log("✅ the wrong-recipient claim REVERTED — the binding holds; the message stays claimable for the bound recipient")
}

function selectToken(argv: string[], manifest: ManifestV2, tokens: ManifestToken[]): ManifestToken {
	const erc20 = flagValue(argv, "--token")
	if (!erc20) {
		const first = tokens[0]
		if (!first) throw new Error("the manifest carries no tokens — nothing to relay")
		return first
	}
	const found = manifestToken(manifest, erc20)
	if (!found) throw new Error(`--token ${erc20} is not in the manifest`)
	return found
}

async function main(): Promise<void> {
	// Validate everything OFFLINE before touching the network. A valid v2 manifest is salt-v2 by
	// schema, so the recipient-commitment interlock is satisfied by parsing alone.
	const manifest = loadManifestV2FromConfigArg(process.argv, { mode: "fallback", fallbackPath: MANIFEST_PATH })
	const bridge = requireBridge(manifest)
	const token = selectToken(process.argv, manifest, bridge.tokens)
	const descriptor: RelayClaimDescriptor = parseClaimDescriptor(JSON.parse(readFileSync(claimPathFromArgv(process.argv), "utf8")))
	if (descriptor.bridge.toLowerCase() !== bridge.l2.hub.address.toLowerCase()) {
		throw new Error(`descriptor names ${descriptor.bridge} but the manifest hub is ${bridge.l2.hub.address} — refusing`)
	}
	const relayerSecret = requireRelayerSecret(process.env)
	console.log(`relaying ${token.displaySymbol} claim:`, redactDescriptorForLog(descriptor))

	const { ewallet, from, sendOpts } = await relayerWallet(relayerSecret)
	const hub = await registerHub(ewallet, bridge.l2.hub)
	await registerHubToken(ewallet, hub.address, token, bridge.l2.tokenClassId)

	const claim: HubClaimParams = {
		token: tokenBlock(token, flagValue(process.argv, "--register-index")),
		recipient: descriptor.recipient,
		amount: descriptor.amount,
		claimValue: descriptor.salt,
		leafIndex: descriptor.leafIndex,
		isPrivate: !process.argv.includes("--public"),
		from: from.toString(),
	}
	if (process.argv.includes("--wrong-recipient")) return await runRedirectCanary(hub, claim, from.toString(), sendOpts)

	// The message may not be in the tree the instant the relayer is handed the descriptor; every
	// other failure is final and surfaces on the first attempt.
	const outcome = await claimTokensUntilSynced({ hub, claim, sendOpts, attempts: 5, intervalMs: 15_000 })
	console.log(`✅ relayed the ${claim.isPrivate ? "private" : "public"} claim (${outcome.path}) — tx ${outcome.claimTxHash}`)
}

main().catch((err: unknown) => {
	// Never let a stack trace carry the salt/secret — print only the message.
	console.error("relay-claim failed:", err instanceof Error ? err.message : String(err))
	process.exit(1)
})
