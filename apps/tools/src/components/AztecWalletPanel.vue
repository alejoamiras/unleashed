<script setup lang="ts">
/** Components */
import { Button, Icon } from "@unleashed/design"
import AccountSwitcher from "./AccountSwitcher.vue"
import VerificationModal from "./VerificationModal.vue"

/** Composables */
import { useWalletConnection } from "@/composables/useWalletConnection"

/** Utils */
import { computed } from "vue"
import { TESTIDS } from "@/lib/testids"
import { sanitizeWalletName } from "@/lib/wallet-name"

/**
 * The Aztec wallet chip: the connect state machine, the account switcher once connected, and the
 * emoji verification modal. Both sections read the ONE session singleton; the `variant` only picks
 * the testid set each smoke drives and whether the no-wallet state offers the install CTA (the
 * faucet is the front door for a visitor with no wallet; the bridge's strip explains instead).
 */
const props = withDefaults(defineProps<{ variant?: "faucet" | "bridge" }>(), { variant: "bridge" })

const IDS = {
	faucet: {
		root: TESTIDS.status,
		account: TESTIDS.account,
		disconnect: TESTIDS.btnDisconnect,
		connect: TESTIDS.btnConnect,
		switchWallet: TESTIDS.btnSwitchWallet,
		settingUp: TESTIDS.settingUp,
		capabilityApproval: TESTIDS.capabilityApproval,
		capabilityRetry: TESTIDS.btnCapabilityRetry,
	},
	bridge: {
		root: TESTIDS.bridgeL2Status,
		account: TESTIDS.bridgeL2Account,
		disconnect: TESTIDS.bridgeL2Disconnect,
		connect: TESTIDS.bridgeL2Connect,
		switchWallet: TESTIDS.bridgeL2SwitchWallet,
		settingUp: undefined,
		capabilityApproval: undefined,
		capabilityRetry: undefined,
	},
} as const
const ids = computed(() => IDS[props.variant])

const {
	status,
	verificationEmojis,
	selectedAccount,
	error,
	preferredWalletName,
	connect,
	confirmVerification,
	cancelVerification,
	retryCapabilities,
	disconnect,
	switchWallet,
	autoReconnectDisabled,
} = useWalletConnection()

const WALLET_INSTALL_URL = import.meta.env.VITE_WALLET_INSTALL_URL ?? "https://nulo.sh"

const connectLabel = computed(() => {
	switch (status.value) {
		case "discovering":
			return "Searching for wallets"
		case "choosing":
			return "Choose a wallet"
		case "verifying":
			return "Verify in wallet"
		case "capability-approval":
			return "Approve permissions"
		case "choosing-account":
			return "Choose your account"
		case "error":
			return "Retry connection"
		default:
			return "Connect Aztec"
	}
})

const showConnectButton = computed(() => status.value !== "connected" && status.value !== "setting-up")
const showCapabilityApproval = computed(
	() => status.value === "capability-approval" || (status.value === "error" && error.value?.category === "capability-rejected"),
)
const showCapabilityError = computed(() => status.value === "error" && error.value?.category === "capability-rejected")
const showNoWalletCta = computed(() => props.variant === "faucet" && status.value === "error" && error.value?.category === "no-wallet")
const showSplitConnect = computed(() => status.value === "idle" && preferredWalletName.value !== null && !autoReconnectDisabled.value)
const shortPreferredName = computed(() => (preferredWalletName.value ? sanitizeWalletName(preferredWalletName.value, 20) : null))

async function onClick() {
	if (status.value === "connected") await disconnect()
	else await connect()
}

function openInstall() {
	window.open(WALLET_INSTALL_URL, "_blank", "noopener")
}
</script>

<template>
	<section class="panel" :data-testid="ids.root" :data-status="status">
		<AccountSwitcher v-if="status === 'connected' && selectedAccount" :address-testid="ids.account" :disconnect-testid="ids.disconnect" />

		<div v-else-if="status === 'setting-up'" class="morph" :data-testid="ids.settingUp">
			<Button loading disabled>Setting up session</Button>
		</div>

		<div v-else-if="showCapabilityApproval" class="morph" :data-testid="ids.capabilityApproval">
			<Button v-if="showCapabilityError" class="denied" variant="destructive" :data-testid="ids.capabilityRetry" @click="retryCapabilities">
				Permissions denied — try again
			</Button>
			<Button v-else loading disabled :data-testid="ids.capabilityRetry" @click="retryCapabilities">
				Approve in your wallet
			</Button>
		</div>

		<div v-else-if="showNoWalletCta" class="no-wallet">
			<span class="no-wallet-note">No Aztec wallet found.</span>
			<Button size="large" :data-testid="TESTIDS.btnInstallWallet" @click="openInstall">Get a wallet</Button>
		</div>

		<div v-else class="connect">
			<div v-if="showConnectButton && showSplitConnect" class="split">
				<Button class="cta" size="large" :data-testid="ids.connect" @click="onClick">
					<Icon name="wallet" :size="24" />
					Connect {{ shortPreferredName }}
				</Button>
				<Button class="caret" size="large" aria-label="Choose a different wallet" :data-testid="ids.switchWallet" @click="switchWallet">
					<Icon name="chevron" :size="12" />
				</Button>
			</div>
			<Button
				v-else-if="showConnectButton"
				class="cta"
				size="large"
				:class="{ denied: status === 'error' }"
				:variant="status === 'error' ? 'destructive' : 'primary'"
				:loading="status === 'discovering'"
				:disabled="status === 'discovering' || status === 'choosing' || status === 'choosing-account'"
				:data-testid="ids.connect"
				@click="onClick"
			>
				<Icon name="wallet" :size="24" />
				{{ connectLabel }}
			</Button>
		</div>

		<VerificationModal :emojis="verificationEmojis" @confirm="confirmVerification" @cancel="cancelVerification" />
	</section>
</template>

<style scoped>
.panel {
	display: inline-flex;
	flex-direction: column;
	gap: 12px;
}

.no-wallet {
	display: inline-flex;
	align-items: center;
	gap: 12px;
}

.no-wallet-note {
	font: 400 13px/1.4 var(--ul-font-body);
	color: var(--ul-ink-2);
	max-width: 22ch;
}

.morph {
	display: inline-flex;
	flex-direction: column;
	gap: 8px;
	align-items: flex-start;
}

/* Button's shared `large` also sizes Back and Continue, so the connect metrics stay local. */
.cta {
	padding: 0 16px;
	font-size: 15px;
}

/* Two notched buttons read as one split control; the gap is the divider. */
.split {
	display: inline-flex;
	gap: 2px;
}

.split .caret {
	min-width: 44px;
	padding: 0 12px;
}

@media (max-width: 760px) {
	.panel {
		flex: 1 1 140px;
	}

	.panel[data-status="connected"] {
		min-width: 0;
	}

	.cta {
		width: 100%;
	}

	/* The connect button morphs in place, so its transient states keep its full width. */
	.morph {
		align-items: stretch;
	}

	.split {
		display: flex;
	}

	.split .cta {
		flex: 1;
		width: auto;
	}
}
</style>
