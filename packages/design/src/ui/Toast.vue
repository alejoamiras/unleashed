<script setup lang="ts">
import Icon, { type IconName } from "../core/Icon.vue"
import type { SeverityTone } from "../severity"

type Kind = Extract<SeverityTone, "ok" | "error" | "info"> | "saved"

const props = withDefaults(
	defineProps<{
		kind?: Kind
		/** Bold opening sentence; `text` follows it on the same line. */
		lead?: string
		text?: string
		link?: { label: string; href: string }
		/** How long the toast stays up; draws the countdown bar over exactly that time. */
		ttlMs?: number
	}>(),
	{ kind: "info" },
)

const emit = defineEmits<{ dismiss: [] }>()

const ICON: Record<Kind, IconName> = { ok: "check", error: "square-alert", info: "info-box", saved: "save" }
</script>

<template>
	<div :class="['toast', 'ul-notch', `toast--${kind}`]" :data-kind="kind" role="status" aria-live="polite">
		<Icon class="toast__icon" :name="ICON[kind]" :size="24" />
		<span class="toast__body">
			<span class="toast__text"><strong v-if="lead" class="toast__lead">{{ lead }}</strong>{{ lead && text ? " " : "" }}{{ text }}</span>
			<a v-if="link" class="toast__link" :href="link.href" target="_blank" rel="noopener noreferrer">
				{{ link.label }}
				<Icon name="external-link" :size="12" />
			</a>
		</span>
		<button class="toast__dismiss" aria-label="Dismiss" @click="emit('dismiss')">
			<Icon name="close" :size="12" />
		</button>
		<span
			v-if="props.ttlMs !== undefined && props.ttlMs > 0"
			class="toast__countdown"
			aria-hidden="true"
			:style="{ '--toast-ttl': `${props.ttlMs}ms` }"
		/>
	</div>
</template>

<style scoped>
.toast {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-4);
	display: inline-flex;
	align-items: flex-start;
	gap: 12px;
	padding: 14px;
	color: var(--ul-ink);
	font-size: 14px;
	line-height: 1.4;
	min-width: 280px;
	max-width: 480px;
}

.toast--ok {
	--toast-ink: var(--ul-carrier);
}

.toast--error {
	--toast-ink: var(--ul-lost);
}

.toast--info {
	--toast-ink: var(--ul-accent-text);
}

.toast--saved {
	--toast-ink: var(--ul-ink);
}

.toast__icon {
	color: var(--toast-ink);
}

.toast__body {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 4px;
	flex: 1;
	min-width: 0;
}

.toast__lead {
	font-weight: 700;
}

.toast__link {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	color: var(--ul-accent-text);
	font-weight: 700;
	text-decoration: none;
}

.toast__link:hover {
	text-decoration: underline;
	text-underline-offset: 3px;
}

.toast__dismiss {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 28px;
	height: 28px;
	color: var(--ul-ink-3);
}

.toast__dismiss:hover {
	color: var(--ul-ink);
}

/* Inset by the notch's 4px so the bar never crosses the stepped bottom corners. */
.toast__countdown {
	position: absolute;
	left: 4px;
	right: 4px;
	bottom: 0;
	height: 2px;
	background: var(--toast-ink);
	opacity: 0.6;
	transform-origin: left center;
	animation: toast-countdown var(--toast-ttl) steps(24, end) forwards;
}

@keyframes toast-countdown {
	from {
		transform: scaleX(1);
	}
	to {
		transform: scaleX(0);
	}
}

@media (prefers-reduced-motion: reduce) {
	.toast__countdown {
		animation: none !important;
		display: none;
	}
}
</style>
