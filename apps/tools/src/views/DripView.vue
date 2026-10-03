<script setup lang="ts">
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { computed } from "vue"
import Footer from "@/components/Footer.vue"
import TokenCard from "@/components/TokenCard.vue"
import { useWalletConnection } from "@/composables/useWalletConnection"
import { IS_MAINNET } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"
import { DRIP_TOKENS } from "@/constants/tokens"
import { NOISE, SIGNAL } from "@/contracts/deployments"

const { status, wallet, selectedAccount, preferredWalletName } = useWalletConnection()

const tokenEntries = computed(() =>
	DRIP_TOKENS.map((token) => ({
		token,
		address: token.symbol === "SIGNAL" ? SIGNAL : NOISE,
	})),
)

const accountAddress = computed(() => (selectedAccount.value ? AztecAddress.fromStringUnsafe(selectedAccount.value) : null))
</script>

<template>
	<Flex direction="column" gap="24" class="drip" :data-testid="TESTIDS.dripView">
		<p v-if="IS_MAINNET" class="sub">
			Play tokens on Aztec mainnet. Connect an Aztec wallet and mint fixed SIGNAL or NOISE into a
			public or private balance. No real value — each mint pays a small fee-juice fee from your
			wallet (bridge some fuel first).
		</p>
		<p v-else class="sub">
			Connect an Aztec wallet and mint fixed test tokens into a public or private balance. Internal drip.
			No real value.
		</p>

		<!--
		Cards always render so the page never collapses into the header
		alone. Composables only activate when the user is connected; the
		`:key` flips on connection state AND the active account so the card
		cleanly re-mounts and the composable lifecycle is unambiguous (no
		half-active polling, and — critically — no drip handle left bound to
		a previously selected account after a switch).
		-->
		<section class="cards">
			<TokenCard
				v-for="entry in tokenEntries"
				:key="`${entry.token.symbol}:${status === 'connected' && accountAddress ? accountAddress.toString() : 'off'}`"
				:token="entry.token"
				:token-address="entry.address"
				:wallet="status === 'connected' && wallet ? wallet : undefined"
				:account="status === 'connected' && accountAddress ? accountAddress : undefined"
				:wallet-name="preferredWalletName"
			/>
		</section>
		<Footer />
	</Flex>
</template>

<style scoped>
.drip {
	width: 100%;
	max-width: 860px;
}

.sub {
	max-width: 640px;
	margin: 0;
	font: 400 16px/1.5 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.cards {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
	align-items: stretch;
	gap: 24px;
}
</style>
