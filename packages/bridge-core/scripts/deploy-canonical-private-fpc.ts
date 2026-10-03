/**
 * Shared PrivateFPC canonical-deploy conductor — the protocol-correctness-
 * critical skeleton both network twins duplicated: stopwatch + node client +
 * pinned-address read + idempotent exists-early-return, then the canonical
 * deploy (PRIVATE_FPC_SALT, deployer ZERO) and the address===pin assertion
 * that proves the deployment landed where the tools app manifest and wallet
 * hardcode expect.
 *
 * The EXISTENCE CHECK RUNS FIRST, before any wallet creation — both callers
 * relied on that ordering (a no-op run must not create wallets or derive
 * keys). Only the fee/account setup genuinely differs per network; it is
 * injected as `prepare`, which receives the wallet + node + stopwatch and
 * returns the deploy's `from` + fee payment.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import { PrivateFPCContract } from "@alejoamiras/private-fee-juice/artifacts/private"
import { PRIVATE_FPC_ADDRESS, PRIVATE_FPC_SALT } from "../src/private-fuel"
import { createL2Wallet, createNode, stopwatch } from "./script-bootstrap"

export interface PrivateFpcPrepareContext {
	ewallet: EmbeddedWallet
	node: ReturnType<typeof createNode>
	mins: () => string
}

export interface PrivateFpcDeployment {
	from: AztecAddress
	fee: { paymentMethod: unknown }
}

/** Returns true when a deploy happened, false on the idempotent early-return —
 *  callers gate their post-deploy-only follow-up logs on it. */
export async function deployCanonicalPrivateFpc(opts: {
	nodeUrl: string
	prepare: (ctx: PrivateFpcPrepareContext) => Promise<PrivateFpcDeployment>
}): Promise<boolean> {
	const mins = stopwatch()
	const node = createNode(opts.nodeUrl)
	const pinned = AztecAddress.fromStringUnsafe(PRIVATE_FPC_ADDRESS)

	if (await node.getContract(pinned)) {
		console.log(`PrivateFPC already deployed at ${PRIVATE_FPC_ADDRESS} — nothing to do.`)
		return false
	}

	const ewallet = await createL2Wallet({ nodeUrl: opts.nodeUrl, proverEnabled: true })
	const { from, fee } = await opts.prepare({ ewallet, node, mins })

	// The CANONICAL salt (PRIVATE_FPC_SALT, fixed from 5.0.0 onward) + universalDeploy (deployer
	// ZERO) reproduces the pinned derivation. The EmbeddedWallet itself is the `Wallet` for the
	// deploy (the account object lacks getContractClassMetadata — same pattern as the tools app's
	// deploy.ts); the prepared account only supplies `from` + pays the fee.
	console.log(`deploying PrivateFPC (canonical salt, deployer ZERO)… (${mins()})`)
	const result = await PrivateFPCContract.deploy(ewallet as never, {
		salt: Fr.fromHexString(PRIVATE_FPC_SALT),
		universalDeploy: true,
	}).send({ fee, from } as never)
	const got = result.instance.address.toString()
	if (got !== PRIVATE_FPC_ADDRESS) {
		throw new Error(`deployed address ${got} != pinned ${PRIVATE_FPC_ADDRESS} — artifact/pin mismatch, investigate`)
	}
	console.log(`✅ PrivateFPC live at ${got} (${mins()})`)
	return true
}
