/**
 * The Aztec line each L1 network runs, keyed by L1 chain, and whether this client can authenticate and claim
 * there. A network whose line is not the installed one emits Inbox events and accepts claims this client cannot
 * build, so nothing may be sent to it. Keyed by L1 chain because a sandbox mints its rollup version at boot; a line
 * bump edits the descriptors, and no node probe can unblock a line.
 */
import installedDescriptor from "./private-fpc-canonical.json" with { type: "json" }
import mainnetDescriptor from "./private-fpc-canonical-mainnet.json" with { type: "json" }

export interface PrivateFpcDescriptor {
	address: `0x${string}`
	/** The Aztec version the artifact was compiled for. */
	version: string
	artifactSha256: string
}

export interface AztecLine {
	supported: boolean
	version: string
	/** The canonical PrivateFPC of that line: private Fee Juice there lands at this address and nowhere else. */
	privateFpc: PrivateFpcDescriptor
}

const ETHEREUM_MAINNET = 1

const descriptorOf = (d: { expectedAddress: string; aztecVersion: string; artifactSha256: string }): PrivateFpcDescriptor => ({
	address: d.expectedAddress as `0x${string}`,
	version: d.aztecVersion,
	artifactSha256: d.artifactSha256,
})

const INSTALLED = descriptorOf(installedDescriptor)

/** A line this client runs: its PrivateFPC was compiled for the installed Aztec version. */
export function lineOf(privateFpc: PrivateFpcDescriptor): AztecLine {
	return { supported: privateFpc.version === INSTALLED.version, version: privateFpc.version, privateFpc }
}

/** Ethereum mainnet's line is pinned by its own descriptor; every other chain (testnet, any sandbox) runs the installed one. */
export function aztecLineOf(l1ChainId: number): AztecLine {
	return lineOf(l1ChainId === ETHEREUM_MAINNET ? descriptorOf(mainnetDescriptor) : INSTALLED)
}

/** Refuses before anything is signed on a network whose line this client does not run. */
export function assertSupportedLine(l1ChainId: number, line: AztecLine = aztecLineOf(l1ChainId)): void {
	if (!line.supported) {
		throw new Error(`L1 chain ${l1ChainId} runs Aztec ${line.version}; this client runs ${INSTALLED.version} and cannot send there`)
	}
}

/** The manifest's `privateFpc` block for a network: its line's canonical PrivateFPC, version and artifact digest. */
export function manifestPrivateFpc(l1ChainId: number): { address: string; version: string; artifactDigest: string } {
	const { address, version, artifactSha256 } = aztecLineOf(l1ChainId).privateFpc
	return { address, version, artifactDigest: artifactSha256 }
}
