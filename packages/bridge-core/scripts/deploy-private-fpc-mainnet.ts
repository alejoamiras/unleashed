import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { preexistingFeeJuicePayment } from "../src/fee-juice"
import { deployCanonicalPrivateFpc } from "./deploy-canonical-private-fpc"
import { resolveDeployerKeys } from "./deployer-keys"

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://lb.drpc.live/aztec-mainnet/Ak_eT5HA2kbyqamqGTF702cdsdWqLTIR8YdadmahlY6k"

const deployed = await deployCanonicalPrivateFpc({
	nodeUrl: NODE_URL,
	prepare: async ({ ewallet, node }) => {
		// The conductor's L2 deployer — its claimed public fee-juice balance pays this deploy.
		const { secret, salt } = resolveDeployerKeys("mainnet")
		const { signingKey, secretKey } = await deriveNuloAccountKeys(secret)
		const manager = await ewallet.createSchnorrAccount(secretKey, salt, signingKey)
		const from = (await manager.getAccount()).getAddress()
		// node.getContract serves instances only once their epoch PROVES — a freshly-deployed account
		// operates (it proved the whole trio) tens of minutes before it is visible there. The serveable
		// existence proof is the PUBLIC fee-juice balance: public state reads at checkpoint level, and a
		// positive balance proves the account-deploy tx landed (the claim and the deploy were ONE tx).
		if (await node.getContract(from)) {
			console.log(`L2 deployer ${from.toString()} visible (proven) — pays via fee juice`)
		} else {
			const { feeJuiceFor } = await import("./fee-juice-l2")
			const fj = await feeJuiceFor(ewallet as never, node as never)
			const r = (await fj.methods.balance_of_public(from).simulate({ from })) as { result?: bigint } | bigint
			const bal = typeof r === "bigint" ? r : (r.result ?? 0n)
			if (bal <= 0n)
				throw new Error(`L2 deployer ${from} has no public FJ and is not visible — run the conductor's L2 group first; STOP`)
			console.log(`L2 deployer ${from.toString()} landed (public FJ ${bal}) — instance not yet proven-visible, proceeding`)
		}

		return { from, fee: { paymentMethod: preexistingFeeJuicePayment(from) } }
	},
})

if (deployed) console.log("   Next: check-fpc-version --mode require-deployed, then the dust canary.")
