<script setup lang="ts">
/** Services */
import { Icon } from "@unleashed/design"

/** Utils */
import { TESTIDS } from "@/lib/testids"

/**
 * The whole mainnet app. It mounts no wallet session, reaches no node and reads no manifest — the
 * build's CSP allows no remote origin at all, so anything beyond these three links would silently
 * fail rather than degrade.
 */
const LINKS = [
	{ label: "Wallet site", href: "https://nulo.sh" },
	{ label: "Get the extension", href: import.meta.env.VITE_WALLET_INSTALL_URL ?? "https://nulo.sh" },
	{ label: "Docs", href: "https://github.com/nulo-sh/nulo" },
] as const
</script>

<template>
	<main class="placeholder" :data-testid="TESTIDS.mainnetPlaceholder">
		<h1>Bridging is being upgraded</h1>
		<p class="sub">Back with the next mainnet generation.</p>
		<p class="links">
			<a
				v-for="link in LINKS"
				:key="link.href"
				:href="link.href"
				target="_blank"
				rel="noopener noreferrer"
				:data-testid="TESTIDS.mainnetPlaceholderLink"
			>{{ link.label }}<Icon name="external-link" :size="12" /></a>
		</p>
	</main>
</template>

<style scoped>
.placeholder {
	display: flex;
	flex-direction: column;
	gap: 16px;
	max-width: 760px;
	margin: 0 auto;
	padding: 120px 32px 96px;
	color: var(--ul-ink);
}

.placeholder h1 {
	margin: 0;
	font: 700 44px/1.04 var(--ul-font-body);
	letter-spacing: -0.02em;
}

.sub {
	margin: 0;
	max-width: 52ch;
	font: 400 16px/1.55 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.links {
	display: flex;
	flex-wrap: wrap;
	gap: 20px;
	margin: 8px 0 0;
	font: 400 13.5px/1 var(--ul-font-mono);
}

.links a {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--ul-accent-text);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.links a:hover {
	color: var(--ul-ink);
}

@media (max-width: 760px) {
	.placeholder {
		padding: 72px 16px 64px;
	}

	.placeholder h1 {
		font-size: 32px;
	}
}
</style>
