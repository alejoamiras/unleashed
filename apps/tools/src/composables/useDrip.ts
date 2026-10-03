import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { DripperContractArtifact } from "@aztec-foundation/aztec-standards/artifacts/src/artifacts/Dripper.js"
import { predictedWorstMinFees } from "@unleashed/bridge-core"
import { reactive, ref } from "vue"
import { DRIPPER } from "@/contracts/deployments"
import { getSponsoredFpcInstance } from "@/contracts/sponsored-fpc"
import { IS_MAINNET, NETWORK } from "@/lib/network"
import type { DripToken, TokenSymbol } from "@/constants/tokens"
import { withOperation } from "./useOpsInFlight"
import { contractsReadinessRefusal, retryOnUnregistered, useWalletConnection } from "./useWalletConnection"
import { type NormalizedError, normalizeError } from "@/lib/errors"

export type DripTarget = "public" | "private"
export type DripState = "idle" | "dripping" | "ok" | "error"

export interface DripResult {
	readonly kind: "txHash" | "error"
	readonly value: string
	readonly category?: NormalizedError["category"]
}

// Global single in-flight gate. Wallet popups serialize on the wallet
// side anyway; letting parallel drips queue creates confusing popup UX.
// `startedAt` lives on the lock, not the card, so the elapsed timer survives the card's
// account-keyed remount.
const inflight = ref<{ tokenSymbol: TokenSymbol; target: DripTarget; startedAt: number } | null>(null)
const last = reactive<Record<string, DripResult | null>>({})

interface DripperInteraction {
	request: (opts?: { fee?: { paymentMethod: SponsoredFeePaymentMethod } }) => Promise<unknown>
}
interface DripperContract {
	methods: Record<string, (...args: unknown[]) => DripperInteraction>
}

export function useDrip(wallet: Wallet, account: AztecAddress) {
	return {
		inflight,
		last,
		isActive: (token: TokenSymbol, target: DripTarget) => inflight.value?.tokenSymbol === token && inflight.value.target === target,
		// withOperation: a drip is an account-sensitive prompt/send span — while it runs, account
		// switching is blocked (useOpsInFlight).
		drip: async (token: DripToken, tokenAddress: AztecAddress, target: DripTarget) =>
			withOperation(() => drip(wallet, account, token, tokenAddress, target)),
	}
}

async function drip(
	wallet: Wallet,
	account: AztecAddress,
	token: DripToken,
	tokenAddress: AztecAddress,
	target: DripTarget,
): Promise<DripResult> {
	if (inflight.value !== null) {
		return { kind: "error", value: "Another drip is in flight." }
	}
	// The view withholds the wallet until connected, but a quiet re-grant can re-register contracts
	// on an already-connected session; refuse a drip issued in that window rather than fail on-chain.
	const notReady = contractsReadinessRefusal(useWalletConnection())
	if (notReady) return { kind: "error", value: notReady }
	inflight.value = { tokenSymbol: token.symbol, target, startedAt: Date.now() }
	const key = `${token.symbol}:${target}`
	try {
		const dripperContract = (await Contract.at(DRIPPER, DripperContractArtifact, wallet)) as unknown as DripperContract
		const fnName = target === "public" ? "drip_to_public" : "drip_to_private"
		const method = dripperContract.methods[fnName]
		if (typeof method !== "function") {
			throw new Error(`Dripper missing method ${fnName}`)
		}
		// TESTNET: pass the fee through `.request({ fee })` so aztec.js merges the SponsoredFPC's
		// `sponsor_unconditionally()` call into exec.calls AND sets exec.feePayer (tagging feePayer
		// manually leaves the public setup phase with no sponsor call — "Setup function not on allow
		// list"). MAINNET has no sponsor: pass NO fee override so the connected wallet applies the
		// user's own fee method (the Nulo wallet defaults Alpha to Private Fee Juice).
		const interaction = method(tokenAddress, token.onchainAmount)
		const exec = IS_MAINNET
			? await interaction.request({})
			: await interaction.request({
					fee: { paymentMethod: new SponsoredFeePaymentMethod((await getSponsoredFpcInstance()).address) },
				})

		// EXPLICIT padded maxFeesPerGas is REQUIRED on the sponsored path, and it must ride in the
		// SEND OPTIONS — the wallet reads `opts.fee.gasSettings` (`processAztecJsPayload`), never
		// the request payload. Without it the wallet caps an embedded-fee tx at
		// `getCurrentMinFees()` — zero headroom, deliberate for budget-asserting claim flows (see
		// the wallet's `applyEmbeddedFpcGasCap`). The base fee moves every block, so a
		// zero-headroom tx loses the race whenever fees tick up during the ~1-2 min prove window
		// and the pool silently drops it ("Tx dropped by P2P node"). `sponsor_unconditionally()`
		// asserts no budget and the sponsor pays ACTUAL gas, not the max — headroom here is free.
		// predicted-worst covers congestion drift; ×1.5 covers the prove window on top.
		//
		// Best-effort: a predict/node hiccup degrades to the wallet's zero-headroom default (the
		// pre-padding behavior, fine while fees are flat) instead of failing the drip outright.
		let paddedMaxFees: unknown
		if (!IS_MAINNET) {
			try {
				paddedMaxFees = (await predictedWorstMinFees(createAztecNodeClient(NETWORK.nodeUrl))).mul(1.5)
			} catch (feeErr) {
				console.warn("[drip] fee padding unavailable, sending with wallet defaults:", feeErr)
			}
		}
		const sendOpts = paddedMaxFees ? { from: account, fee: { gasSettings: { maxFeesPerGas: paddedMaxFees } } } : { from: account }
		// A first drip against a token the wallet has not registered raises CONTRACT_NOT_REGISTERED
		// before proving/broadcast; re-register once and resend (bound to this session's wallet).
		const tx = await retryOnUnregistered(useWalletConnection(), wallet, () =>
			// biome-ignore lint/suspicious/noExplicitAny: SendOptions structural cast for SDK signature variance across versions
			(wallet as any).sendTx(exec, sendOpts as any),
		)
		const txHash = extractTxHash(tx)
		const result: DripResult = { kind: "txHash", value: txHash }
		last[key] = result
		return result
	} catch (err) {
		const norm = normalizeError(err)
		const result: DripResult = { kind: "error", value: norm.message, category: norm.category }
		last[key] = result
		return result
	} finally {
		inflight.value = null
	}
}

/**
 * sendTx with the default wait option returns `{ receipt: TxReceipt }`
 * (TxSendResultMined); with NO_WAIT it returns `{ txHash }`
 * (TxSendResultImmediate). The app uses the mined path, so the hash
 * lives at `tx.receipt.txHash`. The top-level `txHash` fallback keeps
 * test stubs that emit the immediate shape working.
 */
function extractTxHash(tx: unknown): string {
	if (typeof tx === "string") return tx
	if (tx && typeof tx === "object") {
		const t = tx as { receipt?: { txHash?: unknown }; txHash?: unknown; hash?: unknown }
		if (t.receipt?.txHash) return String(t.receipt.txHash)
		if (t.txHash) return String(t.txHash)
		if (t.hash) return String(t.hash)
	}
	return ""
}

export function __resetDripForTests(): void {
	inflight.value = null
	for (const k of Object.keys(last)) delete last[k]
}
