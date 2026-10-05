/**
 * The canary's Aztec side: one fresh account (deployed through the sponsored FPC) that every row deposits
 * to, and each row's hub claim — paid by the Fee Juice the row bridged when it bridged any, by the sponsored
 * FPC otherwise — checked by the recipient's balance moving by the deposit.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { ContractBase } from "@aztec-labs/aztec.js/contracts"
import { TxStatus } from "@aztec-labs/aztec.js/tx"
import type { Address } from "viem"
import { readRegistration } from "../src/factory-registry"
import type { HubClaimOutcome } from "../src/hub-l2"
import type { JournalTokenBlock } from "../src/journal"
import type { ManifestToken, ManifestV2 } from "../src/manifest-v2"
import { type BridgedFuel, registerPrivateFpc, settleFueledClaim } from "./fuel-claim-l2"
import type { RowSecrets } from "./lifi-canary-build"
import { CanaryRefusal, type ClaimRecord } from "./lifi-canary-plan"
import { createL2Wallet, createNode, requireBridge } from "./script-bootstrap"
import {
	claimTokensUntilSynced,
	deployAccountIfAbsent,
	freshSchnorrAccount,
	registerHub,
	registerHubToken,
	sponsoredFpcFee,
} from "./script-l2"

/** One row's claim, from the router's `Deposited` and the secrets the row kept. */
export interface RowClaim {
	label: string
	token: ManifestToken
	amount: bigint
	leafIndex: bigint
	isPrivate: boolean
	secrets: RowSecrets
	/** The bridged Fee Juice; absent when the row bridged none. */
	fuel?: { received: bigint; leafIndex: bigint }
}

export interface CanaryL2 {
	recipient: AztecAddress
	claim(c: RowClaim): Promise<ClaimRecord>
}

/** The factory's frozen registration is the claim's authority; it must be the manifest token's. */
type RegistrationReader = Parameters<typeof readRegistration>[0]

async function claimBlock(reader: RegistrationReader, factory: Address, t: ManifestToken): Promise<JournalTokenBlock> {
	const reg = await readRegistration(reader, factory, t.erc20 as Address)
	const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
	if (
		!reg ||
		!same(reg.portal, t.portal) ||
		!same(reg.nameWord, t.nameWord) ||
		!same(reg.symbolWord, t.symbolWord) ||
		reg.decimals !== t.decimals
	) {
		throw new CanaryRefusal(`the factory's registration of ${t.erc20} is not the manifest's`)
	}
	return {
		erc20: t.erc20,
		portal: t.portal,
		l2Token: t.l2Token,
		nameWord: t.nameWord,
		symbolWord: t.symbolWord,
		decimals: t.decimals,
		displaySymbol: t.displaySymbol,
		registerKey: reg.registerKey,
		registerIndex: reg.registerIndex.toString(),
	}
}

function bridgedFuel(c: RowClaim): BridgedFuel {
	const fuel = c.secrets.fuel
	if (!fuel || !c.fuel) throw new CanaryRefusal(`${c.label}: a fueled claim without its fuel leg`)
	return fuel.via === "public"
		? { via: "public", received: c.fuel.received, leafIndex: c.fuel.leafIndex, secret: fuel.secret }
		: { via: "private-fpc", received: c.fuel.received, leafIndex: c.fuel.leafIndex, bridgeSalt: fuel.bridgeSalt }
}

const recordOf = (o: HubClaimOutcome): ClaimRecord => ({
	path: o.path,
	claimTxHash: o.claimTxHash,
	...(o.registerTxHash ? { registerTxHash: o.registerTxHash } : {}),
})

async function balanceOf(token: ContractBase, of: AztecAddress, isPrivate: boolean): Promise<bigint> {
	const method = isPrivate ? token.methods.balance_of_private(of) : token.methods.balance_of_public(of)
	const r = (await method.simulate({ from: of } as never)) as { result?: bigint } | bigint
	return typeof r === "bigint" ? r : (r.result ?? 0n)
}

/** The PXE can see a `PROPOSED` claim's note a few blocks late; the balance gets this long to catch up. */
const BALANCE_ATTEMPTS = 20
const BALANCE_POLL_MS = 6_000

async function balanceGain(token: ContractBase, of: AztecAddress, isPrivate: boolean, before: bigint, want: bigint): Promise<bigint> {
	for (let attempt = 1; ; attempt++) {
		const gained = (await balanceOf(token, of, isPrivate)) - before
		if (gained >= want || attempt >= BALANCE_ATTEMPTS) return gained
		await new Promise((r) => setTimeout(r, BALANCE_POLL_MS))
	}
}

/**
 * Deploys a fresh recipient account and registers the hub, the PrivateFPC and every token a row claims.
 * Sends one L2 transaction (the account deploy); the caller opens it only for a live run.
 */
export async function openCanaryL2(o: {
	nodeUrl: string
	manifest: ManifestV2
	tokens: readonly ManifestToken[]
	registrations: RegistrationReader
	mins: () => string
}): Promise<CanaryL2> {
	const bridge = requireBridge(o.manifest)
	const node = createNode(o.nodeUrl)
	const ewallet = await createL2Wallet({ nodeUrl: o.nodeUrl, proverEnabled: true })
	const { manager, from } = await freshSchnorrAccount(ewallet as never)
	const { fee: sponsored } = await sponsoredFpcFee(ewallet)
	await deployAccountIfAbsent({
		node,
		manager: manager as never,
		from,
		fee: sponsored,
		log: (s) => console.log(`L2 account ${s} (${o.mins()})`),
	})
	const hub = await registerHub(ewallet as never, bridge.l2.hub)
	const hubAddress = AztecAddress.fromStringUnsafe(bridge.l2.hub.address)
	const l2Tokens = new Map<string, ContractBase>()
	for (const t of o.tokens)
		l2Tokens.set(t.erc20.toLowerCase(), await registerHubToken(ewallet as never, hubAddress, t, bridge.l2.tokenClassId))
	await registerPrivateFpc(ewallet, o.mins)
	const factory = bridge.l1.factory as Address

	return {
		recipient: from,
		async claim(c) {
			const l2Token = l2Tokens.get(c.token.erc20.toLowerCase())
			if (!l2Token) throw new CanaryRefusal(`${c.label}: ${c.token.erc20} was not registered with the wallet`)
			const token = await claimBlock(o.registrations, factory, c.token)
			const before = await balanceOf(l2Token, from, c.isPrivate)
			const params = { amount: c.amount, claimValue: c.secrets.tokenClaimValue, leafIndex: c.leafIndex, isPrivate: c.isPrivate }
			const outcome = c.fuel
				? (await settleFueledClaim({ label: c.label, hub, node, from, token, ...params, fuel: bridgedFuel(c), mins: o.mins }))
						.outcome
				: await claimTokensUntilSynced({
						hub,
						claim: { token, recipient: from.toString(), from: from.toString(), ...params },
						sendOpts: { from, fee: sponsored, wait: { waitForStatus: TxStatus.PROPOSED } },
					})
			const gained = await balanceGain(l2Token, from, c.isPrivate, before, c.amount)
			if (gained < c.amount) throw new CanaryRefusal(`${c.label}: the claim landed ${gained}, under the deposited ${c.amount}`)
			return recordOf(outcome)
		},
	}
}
