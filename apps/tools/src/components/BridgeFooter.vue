<script setup lang="ts">
/** Services */
import { computed } from "vue"

/** Utils */
import { FUEL_PORTAL, GENERATION, HUB } from "@/contracts/bridge-generation"
import { etherscanAddressUrl, explorerAddressUrl } from "@/lib/explorer"
import { IS_MAINNET, NETWORK } from "@/lib/network"

/** The generation's own contracts, so a reader can check what this build actually sends through. */
const links = computed(() => ({
	factory: GENERATION ? etherscanAddressUrl(GENERATION.l1.factory) : "",
	router: GENERATION ? etherscanAddressUrl(GENERATION.l1.router) : "",
	feeJuicePortal: etherscanAddressUrl(FUEL_PORTAL),
	hub: HUB ? explorerAddressUrl(HUB.toString()) : "",
}))
</script>

<template>
	<footer class="footer">
		<p class="contracts">
			<span>{{ NETWORK.viemChain.name }}:</span>
			<a v-if="links.factory" :href="links.factory" target="_blank" rel="noopener noreferrer">Portal factory</a>
			<span v-else>Portal factory</span>
			<a v-if="links.router" :href="links.router" target="_blank" rel="noopener noreferrer">Router</a>
			<span v-else>Router</span>
			<a v-if="links.feeJuicePortal" :href="links.feeJuicePortal" target="_blank" rel="noopener noreferrer">Fee Juice portal</a>
			<span v-else>Fee Juice portal</span>
			<span class="aztec">Aztec:</span>
			<a v-if="links.hub" :href="links.hub" target="_blank" rel="noopener noreferrer">Bridge hub</a>
			<span v-else>Bridge hub</span>
		</p>
		<p v-if="IS_MAINNET" class="warning">Real funds — keep it small</p>
	</footer>
</template>

<style scoped>
.footer {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 0 0 22px;
	color: var(--ul-ink-3);
	font: 400 12.5px/1.5 var(--ul-font-body);
}

.contracts {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 14px;
	margin: 0;
}

.aztec {
	margin-left: 10px;
}

.contracts a {
	color: var(--ul-ink-2);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.contracts a:hover {
	color: var(--ul-ink);
}

.warning {
	margin: 0;
}
</style>
