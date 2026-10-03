/**
 * One-shot after a testnet reset: universally deploy the PrivateFPC at the CANONICAL salt
 * (`PRIVATE_FPC_SALT`, `0x…01` from 5.0.0 onward), deployer ZERO, so its address matches the
 * pinned `PRIVATE_FPC_ADDRESS` in `src/private-fuel.ts`. The deployment is permissionless (the
 * derivation binds no deployer), idempotent (exits early if the instance already exists),
 * and fee-paid by a throwaway account via the network's SponsoredFPC.
 *
 * The conductor skeleton lives in deploy-canonical-private-fpc.ts; this file owns only the
 * testnet fee/account setup (throwaway account, SponsoredFPC pays).
 *
 * Run: bun run scripts/deploy-private-fpc-testnet.ts   (no env needed beyond AZTEC_NODE_URL override)
 */
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { SPONSORED_FPC_SALT } from "@aztec-labs/constants"
import { SponsoredFPCContract } from "@aztec-labs/noir-contracts.js/SponsoredFPC"
import { deriveNuloAccountKeys } from "@alejoamiras/nulo-wallet-crypto"
import { deployCanonicalPrivateFpc } from "./deploy-canonical-private-fpc"
import { TESTNET_NODE_URL } from "../src/testnet-node"

const NODE_URL = process.env.AZTEC_NODE_URL ?? TESTNET_NODE_URL

await deployCanonicalPrivateFpc({
	nodeUrl: NODE_URL,
	prepare: async ({ ewallet, node, mins }) => {
		// Throwaway account; the SponsoredFPC pays its deployment AND the FPC deploy.
		const secret = Fr.random()
		const { signingKey, secretKey } = await deriveNuloAccountKeys(secret)
		const manager = await ewallet.createSchnorrAccount(secretKey, Fr.random(), signingKey)
		const l2account = await manager.getAccount()

		const sponsored = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, {
			salt: new Fr(SPONSORED_FPC_SALT),
		})
		try {
			await ewallet.registerContract(sponsored, SponsoredFPCContract.artifact)
		} catch {}
		const fee = { paymentMethod: new SponsoredFeePaymentMethod(sponsored.address) }

		if (!(await node.getContract(l2account.getAddress()))) {
			console.log(`deploying the throwaway account (sponsored, real proof)… (${mins()})`)
			const deployMethod = await manager.getDeployMethod()
			await deployMethod.send({ fee, from: "NO_FROM" as never } as never)
			console.log(`account deployed (${mins()})`)
		}

		return { from: l2account.getAddress(), fee }
	},
})
