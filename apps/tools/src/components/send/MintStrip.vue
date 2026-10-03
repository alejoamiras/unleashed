<script setup lang="ts">
/** Services */
import { awaitL1Receipt } from "@unleashed/bridge-core"
import { BusyPixels, Icon, Tag } from "@unleashed/design"
import { computed, ref } from "vue"

/** Composables */
import { useL1Wallet } from "@/composables/useL1Wallet"

/** Utils */
import { MANIFEST_TOKENS } from "@/contracts/bridge-generation"
import { MINTABLE_ERC20_ABI } from "@/lib/erc20-abi"
import { NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"
import { safeSentence } from "@/lib/token-display"

/**
 * One-tap Ethereum mints for the test tokens the manifest publishes as permissionless. It renders
 * for nothing else: only a token the generation itself lists can be trusted to expose `mint`, the
 * amount is capped by the per-transaction limit that token was published with, and a mainnet
 * manifest lists none — so this strip is the whole difference between the networks on this step.
 */
const emit = defineEmits<{ minted: [erc20: string] }>()

const WHOLE_PER_MINT = 100n

interface Mintable {
	erc20: `0x${string}`
	symbol: string
	decimals: number
	whole: bigint
}

function wholeOf(cap: number | undefined): bigint {
	if (cap === undefined) return WHOLE_PER_MINT
	const capped = BigInt(Math.floor(cap))
	return capped < WHOLE_PER_MINT ? capped : WHOLE_PER_MINT
}

const mintable = computed<Mintable[]>(() =>
	MANIFEST_TOKENS.filter((t) => t.source === "permissionless-mint").map((t) => ({
		erc20: t.erc20 as `0x${string}`,
		symbol: t.displaySymbol,
		decimals: t.decimals,
		whole: wholeOf(t.maxWholePerTx),
	})),
)

const l1 = useL1Wallet()
/** The token being minted; every button waits while one is in flight. */
const minting = ref<string | null>(null)
const error = ref<string | null>(null)

/** Only a failure is worth a line; the button itself says a mint is running. */
const status = computed(() => error.value)

async function mint(token: Mintable): Promise<void> {
	if (minting.value) return
	const wallet = l1.ensureWalletClient()
	const owner = l1.address.value
	if (!wallet || !owner) {
		error.value = "Connect your Ethereum wallet first."
		return
	}
	minting.value = token.erc20
	error.value = null
	try {
		const hash = await wallet.writeContract({
			address: token.erc20,
			abi: MINTABLE_ERC20_ABI,
			functionName: "mint",
			args: [owner, token.whole * 10n ** BigInt(token.decimals)],
			chain: NETWORK.viemChain,
			account: owner,
		})
		// viem RESOLVES the receipt even on an on-chain revert - check status so a mined revert
		// surfaces as an error rather than a false "minted".
		const receipt = await awaitL1Receipt(l1.publicClient, hash)
		if (receipt.status !== "success") throw new Error("Mint transaction reverted on-chain.")
		emit("minted", token.erc20)
	} catch (e) {
		error.value = e instanceof Error ? safeSentence(e.message) : "Mint failed"
	} finally {
		minting.value = null
	}
}
</script>

<template>
	<div v-if="mintable.length > 0" class="strip ul-notch" :data-testid="TESTIDS.mintL1Card">
		<div class="row">
			<Tag tone="testnet">Testnet</Tag>
			<span class="lead">Free test tokens:</span>
			<span class="buttons">
				<button
					v-for="token in mintable"
					:key="token.erc20"
					type="button"
					class="mint ul-notch"
					:disabled="minting !== null"
					:data-testid="TESTIDS.mintL1"
					:data-symbol="token.symbol"
					:aria-busy="minting === token.erc20 || undefined"
					@click="mint(token)"
				>
					<Icon name="download" :size="12" />
					+{{ token.whole }} {{ token.symbol }}
					<BusyPixels v-if="minting === token.erc20" aria-hidden="true" />
				</button>
			</span>
		</div>
		<p v-if="status" class="status" aria-live="polite" :data-testid="TESTIDS.mintL1Status" :data-error="error ? 'true' : undefined">
			{{ status }}
		</p>
	</div>
</template>

<style scoped>
.strip {
	--ul-fill: var(--ul-field);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin-bottom: 16px;
	padding: 6px 6px 6px 8px;
}

.row {
	display: flex;
	align-items: center;
	gap: 12px;
	flex-wrap: wrap;
}

.lead {
	font: 400 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.buttons {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
}

.mint {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	gap: 8px;
	min-height: 36px;
	padding: 0 12px;
	color: var(--ul-ink);
	font: 700 14px/1 var(--ul-font-mono);
	cursor: pointer;
}

.mint:hover:not(:disabled) {
	--ul-fill: var(--ul-line);
}

.mint:disabled {
	color: var(--ul-disabled);
	cursor: not-allowed;
}

/* Disabled like its siblings, but the one minting keeps its ink so the pixels read as progress. */
.mint[aria-busy="true"] {
	color: var(--ul-ink);
	cursor: progress;
}

.status {
	margin: 0;
	padding: 0 4px 4px;
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.status[data-error] {
	color: var(--ul-lost);
}
</style>
