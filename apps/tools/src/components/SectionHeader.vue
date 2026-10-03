<script setup lang="ts">
import { TESTIDS } from "@/lib/testids"

defineProps<{ title: string; subline: string }>()
</script>

<template>
	<header class="header" :data-testid="TESTIDS.sectionHeader">
		<div class="titles">
			<h1>{{ title }}</h1>
			<p class="sub">{{ subline }}</p>
		</div>
		<div class="wallets"><slot name="wallets" /></div>
	</header>
</template>

<style scoped>
.header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	position: relative;
	min-height: 72px;
	padding: 0 36px;
}

/* Drawn over the header's last 2px, so the perforation never moves the layout between themes. */
.header::after {
	content: "";
	position: absolute;
	inset: auto 0 0;
	border-bottom: 2px dotted var(--ul-perforation);
	pointer-events: none;
}

.titles {
	min-width: 0;
}

h1 {
	margin: 0;
	font: 700 28px/1.1 var(--ul-font-body);
	letter-spacing: var(--ul-tracking-heading);
}

.sub {
	margin: 6px 0 0;
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.wallets {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: none;
}

@media (max-width: 760px) {
	.header {
		flex-direction: column;
		align-items: stretch;
		gap: 12px;
		padding: 14px 16px;
	}

	.titles {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	h1 {
		font-size: 26px;
		line-height: 1.2;
	}

	.sub {
		margin: 0;
		white-space: normal;
	}

	.wallets {
		flex-direction: column;
		align-items: stretch;
		gap: 6px;
	}
}
</style>
