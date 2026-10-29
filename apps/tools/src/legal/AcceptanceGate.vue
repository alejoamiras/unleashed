<script setup lang="ts">
import { Button, Icon } from "@unleashed/design"
import { LEGAL_URLS, PRIVACY, TERMS } from "@unleashed/legal"
import { nextTick, onMounted, ref, useTemplateRef } from "vue"
import { browserStorage, injectedProvider, recordAcceptance, type SignFailure, signAcceptance, signFailure } from "./acceptance"
import { GATE_TESTIDS } from "./testids"

defineProps<{
	/** The stored record names older documents: same page, the re-ask heading and paragraph. */
	reask: boolean
}>()

const emit = defineEmits<{ accepted: [] }>()

type Phase = "idle" | "pending" | "no-wallet" | SignFailure

const STATUS: Record<Exclude<Phase, "idle">, { text: string; warn: boolean }> = {
	pending: {
		text: "Check your wallet and read the message, then sign or cancel. If no window opened, open your wallet from the browser's toolbar.",
		warn: false,
	},
	refused: {
		text: "You did not sign. Unleashed stays closed until you accept the Terms. You can sign whenever you are ready.",
		warn: false,
	},
	busy: {
		text: "Your wallet already has a request from this page waiting. Open your wallet, sign or cancel it, then try again.",
		warn: true,
	},
	"no-wallet": {
		text: "No Ethereum wallet found in this browser. Install one, such as Rabby or MetaMask, then reload this page.",
		warn: true,
	},
	failed: {
		text: "Your wallet could not sign this message, or sent back a signature this page cannot check. Try again, or use another account. Some smart-contract accounts cannot sign here yet.",
		warn: true,
	},
}

const DOCS = [
	{ label: "Terms of Use", href: LEGAL_URLS["unleashed-terms-of-use"], updated: TERMS.updated },
	{ label: "Privacy Policy", href: LEGAL_URLS["unleashed-privacy-policy"], updated: PRIVACY.updated },
] as const

const phase = ref<Phase>("idle")
const heading = useTemplateRef<HTMLHeadingElement>("heading")
const signButton = useTemplateRef<{ $el: HTMLButtonElement }>("signButton")

onMounted(() => heading.value?.focus())

async function sign() {
	// Read at press time: some wallets inject `window.ethereum` after the page has loaded.
	const provider = injectedProvider()
	if (!provider) {
		phase.value = "no-wallet"
		return
	}
	phase.value = "pending"
	try {
		const record = await signAcceptance(provider, window.location.origin)
		recordAcceptance(browserStorage, record)
		emit("accepted")
	} catch (e) {
		phase.value = signFailure(e)
		// Disabling the focused button sent focus to the body; give it back so the keyboard can retry.
		await nextTick()
		if (document.activeElement === document.body) signButton.value?.$el.focus()
	}
}
</script>

<template>
	<main class="gate" :data-testid="GATE_TESTIDS.gate">
		<h1 ref="heading" tabindex="-1">{{ reask ? "The Terms or the Privacy Policy changed" : "Before you use Unleashed" }}</h1>
		<template v-if="reask">
			<p class="body">One or both have a new version. Read them, then sign to keep using Unleashed.</p>
		</template>
		<template v-else>
			<p class="body">
				Unleashed is experimental software. Its operator never takes custody of your funds or keys, and cannot
				reverse a transaction you send.
			</p>
			<p class="body">
				To continue, sign a message with your Ethereum wallet. It says you agree to the Terms of Use and have read
				the Privacy Policy. Signing is free and sends no transaction.
			</p>
		</template>
		<ul class="docs">
			<li v-for="doc in DOCS" :key="doc.href">
				<a :href="doc.href" target="_blank" rel="noopener noreferrer" :data-testid="GATE_TESTIDS.docLink"
					>{{ doc.label }}<Icon name="external-link" :size="12"
				/></a>
				<span class="date">updated {{ doc.updated }}</span>
			</li>
		</ul>
		<div class="action">
			<Button
				ref="signButton"
				size="large"
				:loading="phase === 'pending'"
				:disabled="phase === 'pending'"
				:data-testid="GATE_TESTIDS.sign"
				@click="sign"
				>{{ phase === "pending" ? "Waiting for your wallet…" : "Sign with your wallet" }}</Button
			>
			<p class="hint">Your wallet may ask you to connect to this site first.</p>
			<!-- Mounted empty and filled later: most screen readers skip a live region inserted with its text. -->
			<p
				role="status"
				:class="['status', { warn: phase !== 'idle' && STATUS[phase].warn }]"
				:data-testid="GATE_TESTIDS.status"
			>{{ phase === "idle" ? "" : STATUS[phase].text }}</p>
		</div>
	</main>
</template>

<style scoped>
.gate {
	display: flex;
	flex-direction: column;
	gap: 16px;
	max-width: 560px;
	margin: 0 auto;
	padding: 120px 32px 96px;
	color: var(--ul-ink);
}

.gate h1 {
	margin: 0;
	font: 700 44px/1.04 var(--ul-font-body);
	letter-spacing: -0.02em;
	outline: none;
}

.body {
	margin: 0;
	font: 400 16px/1.55 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.docs {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin: 8px 0 0;
	padding: 0;
	list-style: none;
	font: 400 13.5px/1.3 var(--ul-font-mono);
}

.docs a {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--ul-accent-text);
	text-decoration: underline dotted;
	text-underline-offset: 4px;
}

.date {
	margin-left: 12px;
	color: var(--ul-ink-3);
}

.action {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 10px;
	margin-top: 16px;
}

.hint {
	margin: 0;
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-3);
}

.status {
	margin: 6px 0 0;
	font: 400 15px/1.5 var(--ul-font-body);
	color: var(--ul-ink);
}

.status.warn {
	color: var(--ul-attention);
}

@media (max-width: 760px) {
	.gate {
		padding: 72px 16px 64px;
	}

	.gate h1 {
		font-size: 32px;
	}

	.date {
		display: block;
		margin: 4px 0 0;
	}
}
</style>
