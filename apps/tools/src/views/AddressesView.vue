<script setup lang="ts">
/** Utils */
import { Icon } from "@unleashed/design"
import { onBeforeUnmount, ref } from "vue"
import { FUEL_PORTAL, GENERATION, HUB } from "@/contracts/bridge-generation"
import { DRIPPER, NOISE, SIGNAL } from "@/contracts/deployments"
import { etherscanAddressUrl, explorerAddressUrl } from "@/lib/explorer"
import { NETWORK } from "@/lib/network"
import { TESTIDS } from "@/lib/testids"

interface ContractRow {
	name: string
	address: string
	href: string
}

function row(name: string, address: string, link: (a: string) => string): ContractRow {
	return { name, address, href: link(address) }
}

/** Every contract this build talks to, so a reader can check them before trusting a send. The bridge's
 *  rows exist only once a generation is promoted; the faucet's always do. */
const groups = [
	{
		heading: `Ethereum · ${NETWORK.viemChain.name}`,
		rows: GENERATION
			? [
					row("Portal factory", GENERATION.l1.factory, etherscanAddressUrl),
					row("Router", GENERATION.l1.router, etherscanAddressUrl),
					row("Fee Juice portal", FUEL_PORTAL, etherscanAddressUrl),
				]
			: [],
	},
	{
		heading: "Aztec",
		rows: [
			...(HUB ? [row("Bridge hub", HUB.toString(), explorerAddressUrl)] : []),
			row("SIGNAL", SIGNAL.toString(), explorerAddressUrl),
			row("NOISE", NOISE.toString(), explorerAddressUrl),
			row("Dripper", DRIPPER.toString(), explorerAddressUrl),
		],
	},
].filter((g) => g.rows.length > 0)

const copied = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function onCopy(address: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(address)
		copied.value = address
		if (copiedTimer) clearTimeout(copiedTimer)
		copiedTimer = setTimeout(() => {
			copied.value = null
		}, 1200)
	} catch {
		// Clipboard denied: the full address stays on screen to select by hand.
	}
}
onBeforeUnmount(() => {
	if (copiedTimer) clearTimeout(copiedTimer)
})
</script>

<template>
	<div class="addresses" :data-testid="TESTIDS.addressesView">
		<section v-for="group in groups" :key="group.heading" class="group">
			<h2 class="eb">{{ group.heading }}</h2>
			<ul class="rows ul-notch">
				<li v-for="c in group.rows" :key="c.name" class="row" :data-testid="TESTIDS.addressRow" :data-contract="c.name">
					<span class="name">{{ c.name }}</span>
					<code class="addr">{{ c.address }}</code>
					<span class="actions">
						<button type="button" class="act" :aria-label="`Copy the ${c.name} address`" @click="onCopy(c.address)">
							<Icon :name="copied === c.address ? 'check' : 'copy'" :size="24" />
						</button>
						<a
							v-if="c.href"
							class="act"
							:href="c.href"
							target="_blank"
							rel="noopener noreferrer"
							:aria-label="`Open ${c.name} in the explorer`"
						>
							<Icon name="external-link" :size="24" />
						</a>
					</span>
				</li>
			</ul>
		</section>
	</div>
</template>

<style scoped>
.addresses {
	display: flex;
	flex-direction: column;
	gap: 28px;
	width: 100%;
	max-width: 900px;
}

.group {
	display: flex;
	flex-direction: column;
	gap: 10px;
}

.eb {
	margin: 0;
	font: 700 13px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
}

.rows {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-4);
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 6px 0;
	list-style: none;
}

.row {
	display: grid;
	grid-template-columns: 160px 1fr auto;
	align-items: center;
	gap: 4px 16px;
	padding: 8px 12px 8px 20px;
}

.row + .row {
	border-top: 1px solid var(--ul-line);
}

.name {
	font: 600 14px/1.4 var(--ul-font-body);
	color: var(--ul-ink);
}

.addr {
	min-width: 0;
	overflow-wrap: anywhere;
	font: 400 13px/1.5 var(--ul-font-mono);
	color: var(--ul-ink-2);
}

.actions {
	display: inline-flex;
	gap: 2px;
}

.act {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	color: var(--ul-ink-2);
}

.act:hover {
	color: var(--ul-ink);
}

button.act {
	cursor: copy;
}

@media (max-width: 760px) {
	.row {
		grid-template-columns: 1fr auto;
		padding: 8px 12px;
	}

	/* 11.5px keeps a 42-character Ethereum address on one line at 360px+ (this mono advances 0.665em). */
	.addr {
		grid-column: 1 / -1;
		grid-row: 2;
		font-size: 11.5px;
	}
}
</style>
