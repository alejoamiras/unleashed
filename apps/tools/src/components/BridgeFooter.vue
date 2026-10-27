<script setup lang="ts">
import { lifiBook } from "@unleashed/bridge-core"
import { computed } from "vue"
import { appSources } from "@/composables/useSourceChain"
import { FUEL_PORTAL, GENERATION, HUB } from "@/contracts/bridge-generation"
import { chainAddressUrl, chainLabel } from "@/lib/chains"
import { explorerAddressUrl } from "@/lib/explorer"
import { IS_MAINNET, NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"

/**
 * The page's foot: with `contracts`, every contract a send touches, per chain, so a reader can check
 * them before trusting one; on mainnet, the real-funds line. A contract whose explorer page this build
 * cannot link is left out rather than shown dead.
 */
const props = defineProps<{ contracts?: boolean }>()

interface ContractGroup {
	chain: string
	links: { name: string; href: string }[]
}

function lifiDiamond(chainId: number): string {
	try {
		return lifiBook(chainId).diamond
	} catch {
		return ""
	}
}

function sourceGroups(): ContractGroup[] {
	return appSources().map((s) => ({
		chain: chainLabel(s.chainId),
		links: [{ name: "LI.FI", href: chainAddressUrl(s.chainId, lifiDiamond(s.chainId)) }],
	}))
}

function bridgeGroups(): ContractGroup[] {
	if (!GENERATION) return []
	const l1 = NETWORK.l1ChainId
	const router = GENERATION.l1.depositRouter
	return [
		{
			chain: chainLabel(l1),
			links: [
				{ name: "Portal factory", href: chainAddressUrl(l1, GENERATION.l1.factory) },
				...(router ? [{ name: "Unleashed router", href: chainAddressUrl(l1, router) }] : []),
				{ name: "Fee Juice portal", href: chainAddressUrl(l1, FUEL_PORTAL) },
			],
		},
		{ chain: "Aztec", links: HUB ? [{ name: "Bridge hub", href: explorerAddressUrl(HUB.toString()) }] : [] },
	]
}

const groups = computed(() => {
	if (!props.contracts) return []
	return [...sourceGroups(), ...bridgeGroups()]
		.map((g) => ({ ...g, links: g.links.filter((l) => l.href !== "") }))
		.filter((g) => g.links.length > 0)
})
</script>

<template>
	<footer v-if="groups.length > 0 || IS_MAINNET" class="footer">
		<p v-if="groups.length > 0" class="contracts">
			<template v-for="group in groups" :key="group.chain">
				<span class="chain">{{ group.chain }}:</span>
				<a
					v-for="link in group.links"
					:key="link.name"
					:href="link.href"
					target="_blank"
					rel="noopener noreferrer"
					:data-testid="TESTIDS.footerContract"
					>{{ link.name }}</a
				>
			</template>
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

.chain:not(:first-child) {
	margin-left: 10px;
}

.contracts a {
	color: var(--ul-ink-2);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.warning {
	margin: 0;
}
</style>
