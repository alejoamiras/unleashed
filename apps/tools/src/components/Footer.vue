<script setup lang="ts">
import { computed } from "vue"
import { DRIPPER, NOISE, SIGNAL } from "@/contracts/deployments"
import { explorerAddressUrl } from "@/lib/explorer"

const links = computed(() => ({
	signal: explorerAddressUrl(SIGNAL.toString()),
	noise: explorerAddressUrl(NOISE.toString()),
	dripper: explorerAddressUrl(DRIPPER.toString()),
}))
</script>

<template>
	<footer class="footer">
		<p class="contracts">
			Contracts:
			<a v-if="links.signal" class="mono" :href="links.signal" target="_blank" rel="noopener noreferrer">SIGNAL</a>
			<span v-else class="mono">SIGNAL</span>
			·
			<a v-if="links.noise" class="mono" :href="links.noise" target="_blank" rel="noopener noreferrer">NOISE</a>
			<span v-else class="mono">NOISE</span>
			·
			<a v-if="links.dripper" :href="links.dripper" target="_blank" rel="noopener noreferrer">Dripper</a>
			<span v-else>Dripper</span>
		</p>
		<p class="credits">
			<a href="https://github.com/defi-wonderland/aztec-standards" target="_blank" rel="noopener noreferrer">Wonderland aztec-standards</a>
			·
			<a href="https://aztec.network/" target="_blank" rel="noopener noreferrer">Aztec Network</a>
		</p>
	</footer>
</template>

<style scoped>
.footer {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	gap: 12px;
	color: var(--ul-ink-3);
	font: 400 13px/1.5 var(--ul-font-body);
}

.mono {
	font-family: var(--ul-font-mono);
}

a {
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

a:hover {
	text-decoration-style: solid;
}

.contracts a {
	color: var(--ul-accent-text);
}

.credits a {
	color: inherit;
}
</style>
