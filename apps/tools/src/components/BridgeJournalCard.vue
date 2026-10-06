<script setup lang="ts">
/** Services */
import {
	type AnyJournalRecord,
	type BridgeJournalRecord,
	type DepositJournalRecord,
	type WithdrawJournalRecord,
	isCrossChainRecord,
	isProvisionalRecordId,
} from "@unleashed/bridge-core"
import { Button, Icon, Tag } from "@unleashed/design"
import { computed, ref, watch } from "vue"

/** Composables */
import { useBridgeJournal } from "@/composables/useBridgeJournal"
import { useBridgeWallet } from "@/composables/useBridgeWallet"
import { useOpsInFlight } from "@/composables/useOpsInFlight"
import { useShell } from "@/composables/useShell"
import { switchActiveAccount } from "@/composables/useWalletConnection"

/** Utils */
import { ageWords, classify, routeWords, rowStrings, runningWord, statusPhase } from "@/lib/activity"
import { chainLabel, chainTxUrl } from "@/lib/chains"
import { phaseChip } from "@/lib/crosschain-activity"
import { useNow } from "@/lib/clock"
import { IS_MAINNET } from "@/lib/network"
import { etherscanTxUrl, explorerTxUrl } from "@/lib/explorer"
import { formatElapsed } from "@/lib/phase-clock"
import { accountOf, recordState } from "@/lib/record-policy"
import { TESTIDS } from "@/lib/testids"
import { safeAddressText, safeSentence } from "@/lib/token-display"
import { claimFuelStandalone, overrideFuelClaim, reconcileFuelConsumed } from "@/composables/fuel-recovery"

/** Components */
import BridgePhaseRail from "./BridgePhaseRail.vue"
import CrossChainCardBody from "./CrossChainCardBody.vue"
import RecordChips from "./RecordChips.vue"

const props = defineProps<{ record: AnyJournalRecord }>()
const emit = defineEmits<{ backup: [record: AnyJournalRecord] }>()

const journal = useBridgeJournal()
const exportable = computed(() => {
	if (isProvisionalRecordId(props.record.id)) return false
	const r = props.record
	// A private deposit pre-seal has no recovery material - a file now would be a false promise.
	if (r.direction === "deposit" && r.isPrivate && !(r as DepositJournalRecord).sealedEnvelope) return false
	return true
})

const discardArmed = ref(false)
// An armed Confirm discard that never fires must disarm - a stale armed state turns a later
// stray click into destroying a private deposit's only sealed secret.
let disarmTimer: ReturnType<typeof setTimeout> | undefined
watch(discardArmed, (armed) => {
	clearTimeout(disarmTimer)
	if (armed)
		disarmTimer = setTimeout(() => {
			discardArmed.value = false
		}, 6000)
})

const rt = computed(() => journal.runtime.value[props.record.id] ?? {})
const bridgeWallet = useBridgeWallet()
const walletView = computed(() => ({
	status: bridgeWallet.status.value,
	selectedAccount: bridgeWallet.selectedAccount.value,
	accounts: bridgeWallet.accounts.value,
}))
// The gates live in the shared policy so the activity dock and this card can never disagree.
const state = computed(() => recordState(props.record, rt.value, walletView.value))
const read = computed(() => classify(props.record, state.value))
const lost = computed(() => read.value.status === "lost")

const { busy: opsBusy } = useOpsInFlight()

/** Display copy only: the raw recipient still drives matching. A restore file can carry any string
 *  here, so control and bidi characters are stripped before it can pose as an account. */
function shortAddr(a: string): string {
	const clean = safeAddressText(a)
	return clean.length > 12 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean
}

const acct = computed(() => accountOf(props.record, walletView.value))
const acctName = computed(() => (acct.value ? (acct.value.alias ?? shortAddr(acct.value.addr)) : ""))

/** When the record belongs to ANOTHER granted account, offer the one-click switch instead of bouncing
 *  off the guard's note. A recipient outside the grant keeps the normal action (the engine's mismatch
 *  guard explains why it refuses). */
const offerSwitch = computed(() => state.value.ownedByOther)
const switchLabel = computed(() => (acct.value ? `Switch to ${acctName.value}` : ""))
function onSwitchAccount() {
	const canonical = state.value.switchTarget
	if (canonical) switchActiveAccount(canonical)
}

// The explicit, non-destructive escape: claim the tokens with the gas the account already holds; the FJ message (if
// unconsumed) stays claimable later. Offered only when a fueled claim is stuck on an error.
const showClaimWithoutFuel = computed(() => state.value.showClaimWithoutFuel)
function onClaimWithoutFuel() {
	overrideFuelClaim(props.record.id)
	onAction()
}

const fuel = computed(() => {
	const r = props.record
	return r.direction === "deposit" ? (r as DepositJournalRecord).fuel : undefined
})
// Post-completion fuel recovery: the token side finished but the FJ was neither consumed by an
// fjwc claim nor landed standalone - offer to claim it now (it pays its own claim, safe to retry; a
// reverting "already claimed" just clears the affordance). Shared with `claimFuelStandalone`'s own
// guard, so the affordance and the action can never disagree. It stays on a lost record: the Fee
// Juice is the user's and its claim never runs through the token bridge a block distrusts.
const fuelRecovery = computed(() => state.value.fuelRecovery)
const fuelRecoverable = computed(() => state.value.fuelRecoverable)
/** Private bridge whose private-claim metadata is incomplete: its gas state is genuinely unknown and
 *  the public recovery must not be offered — so say so rather than showing nothing. Deliberately
 *  advertises no action: this renders only on COMPLETED records, which re-run no claim, so any
 *  "retry" advice here would be false. */
const privateFuelUnknown = computed(() => fuelRecovery.value === "private-unknown")
/** Every completion claim on a lost record is qualified: a block never reverses a transfer, and it
 *  never vouches for one either. */
const arrivedWords = computed(() => (lost.value ? "They were previously recorded as arrived." : "Your tokens arrived."))
const claimedByOtherLine = computed(() => {
	if (!state.value.claimedByOther) return null
	if (props.record.completedAt !== undefined)
		return lost.value
			? "Claimed by another submitter — previously recorded as arrived."
			: "Claimed by another submitter — your tokens arrived."
	const lead = lost.value ? "Previously recorded as claimed by another submitter." : "Your tokens were claimed by another submitter."
	return props.record.isPrivate
		? `${lead} Your private gas is still sealed in this record — keep it. Claiming private gas on its own is not available yet.`
		: `${lead} Your gas is still yours to claim — press Claim your gas.`
})
const fuelRecovering = ref(false)
const fuelRecoverError = ref<string | null>(null)

// Reconcile the consumed flag from chain truth when a completed fueled record is shown: the happy
// fjwc path latches `consumed` here (inclusion-grade) so `fuelRecoverable` stays false without the
// button flashing. Best-effort - a failure just leaves the (safe, idempotent) recovery offered.
watch(
	() => props.record.completedAt !== undefined && fuel.value?.received !== undefined && fuel.value?.consumed !== true,
	(needsReconcile) => {
		if (needsReconcile) void reconcileFuelConsumed(props.record.id).catch(() => {})
	},
	{ immediate: true },
)
async function onClaimGas() {
	if (fuelRecovering.value) return
	fuelRecovering.value = true
	fuelRecoverError.value = null
	try {
		await claimFuelStandalone(props.record.id)
	} catch (e) {
		fuelRecoverError.value = e instanceof Error ? safeSentence(e.message) : "Could not claim your gas — try again."
	} finally {
		fuelRecovering.value = false
	}
}
const claimGasLabel = computed(() => {
	if (fuelRecovering.value) return "Claiming gas"
	return lost.value ? "Recover your gas" : "Claim your gas"
})
const claimGasTitle = computed(() =>
	lost.value
		? "Claims the gas this bridge bought, paying its own claim out of the gas that lands."
		: "Your tokens arrived but the gas is still unclaimed — this claims it, paying its own claim out of the gas that lands.",
)

const busy = computed(() => state.value.busy)
const stage = computed(() => state.value.stage)
const attention = computed(() => state.value.attention)
/** Persisted refusal: a re-read of the chain contradicted this record's own token facts. It never
 *  runs again, and unlike the runtime attention it survives a reload — so the card states the
 *  reason from the moment it renders. The text is persisted, so a restore file can carry anything:
 *  stripped and capped like every other stored string before it is shown. */
const blocked = computed(() => (state.value.blocked === undefined ? undefined : safeSentence(state.value.blocked)))
const actionable = computed(() => state.value.actionable)

/** A guidance line: plain runs and the one bold word, rendered as template spans (never HTML). */
type Segment = string | { strong: string }

/** Static copy marks its one bold verb as `*word*`. */
function marked(text: string): Segment[] {
	return text
		.split("*")
		.map((part, i) => (i % 2 === 1 ? { strong: part } : part))
		.filter((part) => part !== "")
}

function depositGuidance(r: DepositJournalRecord, stage: string, legRecoverable: boolean, verb: string): string | null {
	switch (stage) {
		case "depositing":
			// With a recorded tx hash the leg is chain-recoverable (the engine re-derives it from the
			// mined receipt); without one, a hub token send can still be found on Ethereum.
			if (r.depositTxHash)
				return `The Ethereum deposit was sent but its confirmation was interrupted. Press *${verb}* to check it on-chain and continue.`
			return legRecoverable
				? `The deposit was never confirmed here. Press *${verb}* to look for it on Ethereum; discard if you never sent it.`
				: "The deposit never confirmed on Ethereum. Check your wallet activity, then discard if it never landed."
		case "syncing":
		case "claimable":
			return r.isPrivate
				? `Press *${verb}*: one Ethereum signature unseals the recovery secret, then your Aztec wallet confirms.`
				: `Press *${verb}*, then confirm in your Aztec wallet.`
		case "claiming":
			return `Claim sent — press *${verb}* to keep watching it confirm.`
		default:
			return null
	}
}

function withdrawGuidance(stage: string, attachable: boolean, verb: string): string | null {
	switch (stage) {
		case "exiting":
			return attachable
				? `The exit was interrupted before its transaction was recorded. Press *${verb}* to look for it on Aztec; discard if nothing was sent.`
				: "The exit was interrupted. Check your wallet activity, then discard if nothing was sent."
		case "proving":
			return `Press *${verb}* to resume — proving lands in epoch batches and can take a while.`
		case "consumable":
			return `Proven. Press *${verb}*: one Ethereum signature releases the funds.`
		case "consuming":
			return `Finish sent — press *${verb}* to keep watching it confirm.`
		default:
			return null
	}
}

// Buttons appear only when PRESSING them does something: never while the engine is driving.
const idle = computed(() => !state.value.busy)
const showClaim = computed(() => state.value.showClaim)
const showFinish = computed(() => state.value.showFinish)
const retrying = computed(() => attention.value === "unknown-outcome" || attention.value === "error")
/** The word guidance tells the user to press is the label on the button beside it. */
const verb = computed(() => (retrying.value ? "Retry" : props.record.direction === "deposit" ? "Claim" : "Finish"))

/** A running exit waits on Aztec's epoch proving, which needs nothing from this page. */
const leaveable = computed(() => read.value.status === "running" && props.record.direction === "withdraw" && stage.value === "proving")

/** Guidance for an idle card, plus the one line a running exit in proving earns; otherwise, while
 *  the engine drives, the rail narrates live. A done card's summary says everything, and a terminal
 *  record has no Claim/Finish button for a line to point at. */
const guidance = computed<Segment[] | null>(() => {
	if (busy.value) return leaveable.value ? ["You can leave this page."] : null
	if (stage.value === "done" || !actionable.value) return null
	// Another account's record: the switch is the action, so no line may point at a hidden Claim.
	if (offerSwitch.value && state.value.showClaim)
		return ["Waiting to be claimed by your ", { strong: acctName.value }, " account. Switch to it in your wallet, then claim here."]
	if (state.value.claimedByOther)
		return state.value.showClaim
			? marked(`Another submitter claimed this. Press *${verb.value}* to verify it on-chain and finish.`)
			: null
	const r = props.record
	const text =
		r.direction === "deposit"
			? depositGuidance(r as DepositJournalRecord, stage.value, state.value.depositLegRecoverable, verb.value)
			: withdrawGuidance(stage.value, state.value.exitAttachable, verb.value)
	return text ? marked(text) : null
})

/** A cross-chain record, which reads through its own phases until its deposit lands. */
const xc = computed(() => (isCrossChainRecord(props.record) ? props.record : null))
const phase = computed(() => state.value.crossChain)
/** The rail's mapper tells a cross-chain record apart by its own schema. */
const railRecord = computed(() => props.record as BridgeJournalRecord)

/** Another account's card hides its rail, so it states any failure itself. A card keeps its rail to
 *  the end, except an Ethereum-origin one whose completion is now lost: an all-done rail would
 *  contradict its status. */
const railShown = computed(() => {
	if (phase.value) return true
	return (stage.value !== "done" || xc.value !== null || !lost.value) && !state.value.ownedByOther
})

const anotherDeposit = computed(() => {
	const rec = xc.value
	if (!rec || phase.value || !rec.route.extraDeposits?.length) return null
	return `Another deposit for this send was found on ${chainLabel(rec.chainId)}. No action needed.`
})
const showReceipt = computed(() => xc.value !== null && phase.value === null && stage.value === "done" && !lost.value)
const shell = useShell()
const chip = computed(() => {
	const shown = statusPhase(state.value)
	return shown ? phaseChip(shown) : null
})

/** A blocked record's persisted reason, or a soft note (e.g. the 30-min "still confirming"). An
 *  attention's note renders in the rail's failed phase, so a parallel line here would double it. */
const note = computed(() => {
	if (blocked.value !== undefined) return blocked.value
	if (railShown.value && attention.value) return null
	return rt.value.note ? safeSentence(rt.value.note) : null
})

/** The done card's summary; a completed record that is now lost never reads as a success. */
const summary = computed<{ label: string; took?: string } | null>(() => {
	const done = props.record.completedAt
	if (done === undefined) return null
	if (lost.value) return { label: "Previously recorded as arrived" }
	if (read.value.status !== "done") return null
	return done > props.record.createdAt
		? { label: "Arrived in", took: formatElapsed(done - props.record.createdAt) }
		: { label: "Arrived" }
})

const txLinks = computed(() => {
	const links: { label: string; href: string }[] = []
	const source = xc.value?.route
	if (source?.srcTxHash) links.push({ label: "Send tx", href: chainTxUrl(source.srcChainId, source.srcTxHash) })
	if (props.record.direction === "deposit") {
		const rec = props.record as DepositJournalRecord
		if (rec.depositTxHash) links.push({ label: "Deposit tx", href: etherscanTxUrl(rec.depositTxHash) })
		if (rec.claimTxHash) links.push({ label: "Claim tx", href: explorerTxUrl(rec.claimTxHash) })
	} else {
		const rec = props.record as WithdrawJournalRecord
		if (rec.exitTxHash && !rec.exitTxHash.startsWith("wd-pending"))
			links.push({ label: "Exit tx", href: explorerTxUrl(rec.exitTxHash) })
		if (rec.consumeTxHash) links.push({ label: "Finish tx", href: etherscanTxUrl(rec.consumeTxHash) })
	}
	return links.filter((l) => l.href !== "")
})

const strings = computed(() => rowStrings(props.record, phase.value))
const amount = computed(() => `${strings.value.amount} ${strings.value.symbol}`)
/** A gross amount's qualifier leads the route, beside the figure it qualifies. */
const route = computed(() => {
	const q = strings.value.qualifier
	return q ? `${q} · ${routeWords(props.record)}` : routeWords(props.record)
})
const running = computed(() => runningWord(props.record, rt.value))

const now = useNow()
const age = computed(() => ageWords(props.record.createdAt, now.value))

function onAction() {
	if (props.record.direction === "deposit") void journal.runDepositClaim(props.record.id)
	else void journal.runWithdrawConsume(props.record.id)
}

function onDiscard() {
	if (!discardArmed.value) {
		discardArmed.value = true
		return
	}
	journal.discard(props.record.id)
}
</script>

<template>
	<article
		class="journal-card ul-notch"
		:data-testid="TESTIDS.journalCard"
		:data-id="record.id"
		:data-direction="record.direction"
		:data-stage="stage"
		:data-status="read.status"
		:data-privacy="record.isPrivate ? 'private' : 'public'"
		:data-attention="attention"
	>
		<header class="row">
			<strong class="amt">{{ amount }}</strong>
			<span class="dir">{{ route }}</span>
			<RecordChips :record="record" :status="read.status" :running="running" :chip="chip" />
			<Tag
				v-if="offerSwitch && acct"
				size="small"
				tone="other"
				class="acct other"
				:title="safeAddressText(acct.addr)"
				:data-testid="TESTIDS.journalAccount"
				>Other account · {{ acctName }}</Tag
			>
			<span class="age">{{ age }}</span>
		</header>
		<div v-if="fuelRecoverable" class="fuel-recover">
			<Button
				v-if="offerSwitch"
				size="small"
				variant="secondary"
				class="card-btn switch"
				:disabled="opsBusy"
				:title="opsBusy ? 'Finish the current operation to switch.' : `This gas belongs to ${acct?.addr}.`"
				:data-testid="TESTIDS.journalSwitchAccount"
				@click="onSwitchAccount"
			>
				<Icon name="wallet" :size="12" />{{ switchLabel }}
			</Button>
			<Button
				v-else
				size="small"
				class="card-btn"
				:loading="fuelRecovering"
				:disabled="fuelRecovering"
				:data-testid="TESTIDS.journalClaimGas"
				:title="claimGasTitle"
				@click="onClaimGas"
			>
				{{ claimGasLabel }}
			</Button>
			<span v-if="fuelRecoverError" class="fuel-recover-err">{{ fuelRecoverError }}</span>
		</div>

		<p v-if="privateFuelUnknown" class="note" :data-testid="TESTIDS.journalPrivateFuelUnknown">
			<Icon name="info-box" :size="12" class="note-icon" />
			<span>
				This private bridge's gas data is incomplete, so its gas state can't be confirmed. {{ arrivedWords }} Public gas
				recovery doesn't apply to private bridges.
			</span>
		</p>

		<p v-if="claimedByOtherLine" class="note" :data-testid="TESTIDS.journalClaimedByOther">
			<Icon name="info-box" :size="12" class="note-icon" /><span>{{ claimedByOtherLine }}</span>
		</p>

		<BridgePhaseRail v-if="railShown" :record="railRecord" compact />

		<CrossChainCardBody v-if="xc && phase" :record="xc" :phase="phase" :exportable="exportable" @backup="emit('backup', record)" />
		<div v-else-if="guidance" class="guide">
			<p class="stage" :class="{ act: read.counts }" :data-testid="TESTIDS.journalStage">
				<template v-for="(part, i) in guidance" :key="i"
					><strong v-if="typeof part !== 'string'">{{ part.strong }}</strong
					><template v-else>{{ part }}</template></template
				>
			</p>
			<Button
				v-if="showClaim && offerSwitch"
				size="small"
				variant="secondary"
				class="card-btn switch"
				:disabled="opsBusy"
				:title="opsBusy ? 'Finish the current operation to switch.' : `This deposit claims to ${acct?.addr}.`"
				:data-testid="TESTIDS.journalSwitchAccount"
				@click="onSwitchAccount"
			>
				<Icon name="wallet" :size="12" />{{ switchLabel }}
			</Button>
		</div>

		<p v-if="note" class="attention" :data-testid="TESTIDS.journalAttention">
			<Icon :name="lost ? 'square-alert' : 'warning-diamond'" :size="12" class="note-icon" /><span>{{ note }}</span>
		</p>

		<p v-if="anotherDeposit" class="raised-note ul-notch" :data-testid="TESTIDS.journalXcAnotherDeposit">
			<Icon name="info-box" :size="12" class="note-icon" /><span>{{ anotherDeposit }}</span>
		</p>

		<template v-if="!phase">
			<div v-if="summary || txLinks.length" class="summary">
				<span v-if="summary" class="took"
					>{{ summary.label }}{{ summary.took ? " " : "" }}<span v-if="summary.took" class="mono">{{ summary.took }}</span></span
				>
				<span v-if="txLinks.length" class="links">
					<a
						v-for="link in txLinks"
						:key="link.href"
						:href="link.href"
						target="_blank"
						rel="noopener noreferrer"
						:data-testid="TESTIDS.journalTxLink"
						>{{ link.label }}<Icon name="external-link" :size="12"
					/></a>
				</span>
			</div>

			<div class="actions">
				<Button
					v-if="showClaim && !offerSwitch"
					size="small"
					:variant="retrying ? 'secondary' : 'primary'"
					class="card-btn"
					:data-testid="TESTIDS.journalClaim"
					@click="onAction"
				>
					<Icon v-if="retrying" name="reload" :size="12" />{{ retrying ? "Retry" : "Claim" }}
				</Button>
				<Button
					v-if="showFinish"
					size="small"
					:variant="retrying ? 'secondary' : 'primary'"
					class="card-btn"
					:data-testid="TESTIDS.journalFinish"
					@click="onAction"
				>
					<Icon v-if="retrying" name="reload" :size="12" />{{ retrying ? "Retry" : "Finish" }}
				</Button>
				<Button
					v-if="showClaimWithoutFuel && !offerSwitch"
					size="small"
					variant="secondary"
					class="card-btn"
					:data-testid="TESTIDS.journalClaimWithoutFuel"
					title="Claims your tokens with the gas you already hold on Aztec instead. The fuel stays claimable later — nothing is abandoned."
					@click="onClaimWithoutFuel"
				>
					Claim without fuel
				</Button>
				<Button
					v-if="idle && stage !== 'done'"
					size="small"
					:variant="discardArmed ? 'destructive' : 'quiet'"
					class="card-btn"
					:data-testid="discardArmed ? TESTIDS.journalDiscardConfirm : TESTIDS.journalDiscard"
					@click="onDiscard"
				>
					<Icon v-if="discardArmed" name="close" :size="12" />{{ discardArmed ? "Confirm discard" : "Discard" }}
				</Button>
				<Button
					v-if="showReceipt"
					size="small"
					variant="secondary"
					class="card-btn"
					:data-testid="TESTIDS.journalXcReceipt"
					@click="shell.showReceipt(record.id)"
				>
					Show receipt
				</Button>
				<Button
					v-if="stage === 'done'"
					size="small"
					variant="quiet"
					class="card-btn"
					:data-testid="TESTIDS.journalClear"
					@click="journal.clearDone(record.id)"
				>
					Clear
				</Button>
				<button
					v-else-if="exportable"
					type="button"
					class="backup ul-notch"
					aria-label="Back up this bridge"
					title="Download this bridge's recovery file — restores it on any browser with your Ethereum wallet."
					:data-testid="TESTIDS.cardBackup"
					@click="emit('backup', record)"
				>
					<Icon name="save" :size="24" />
				</button>
			</div>

			<p v-if="discardArmed && stage !== 'done' && record.isPrivate && record.direction === 'deposit'" class="discard-warning">
				<Icon name="square-alert" :size="12" class="note-icon" />
				<span>
					Discarding destroys the only copy of this claim's sealed recovery secret — the deposited funds become
					unclaimable{{ IS_MAINNET ? " — these are real funds" : "" }}.
				</span>
			</p>
		</template>
	</article>
</template>

<style scoped>
.journal-card {
	--ul-fill: var(--ul-panel);
	--ul-notch: var(--ul-notch-4);
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 18px 20px;
}

.journal-card[data-status="needs-you"] :deep(.cell.active .seg:not(.partial)),
.journal-card[data-status="needs-you"] :deep(.cell.active .seg-fill) {
	background: var(--ul-attention);
}

.journal-card[data-status="needs-you"] :deep(.cell.active .seg.partial) {
	box-shadow: inset 0 0 0 1px var(--ul-attention);
}

.row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.amt {
	font: 700 15px/1.2 var(--ul-font-mono);
	font-variant-numeric: tabular-nums;
	color: var(--ul-ink);
}

.dir {
	font: 400 13px/1.2 var(--ul-font-body);
	color: var(--ul-ink-2);
}

/* The label carries a wallet-supplied alias: it truncates rather than run off a narrow card. */
.acct {
	max-width: 32ch;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.age {
	margin-left: auto;
	font: 400 12.5px/1 var(--ul-font-mono);
	color: var(--ul-ink-3);
}

.card-btn {
	min-height: 40px;
	padding: 0 14px;
}

/* The label carries a wallet-supplied alias: it wraps rather than run off a narrow card. */
.switch {
	flex: none;
	gap: 8px;
	max-width: 100%;
	margin-left: auto;
	line-height: 1.25;
	white-space: normal;
	overflow-wrap: anywhere;
}

.backup {
	--ul-fill: transparent;
	--ul-notch: var(--ul-notch-2);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 36px;
	height: 36px;
	margin-left: auto;
	padding: 0;
	border: 0;
	background: none;
	color: var(--ul-ink-2);
	cursor: pointer;
	transition: color var(--ul-tick);
}

.backup:hover {
	--ul-fill: var(--ul-raised);
	color: var(--ul-ink);
}

.backup:focus-visible {
	outline: 2px solid var(--ul-ring);
	outline-offset: 3px;
}

.fuel-recover {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 12px;
}

.fuel-recover .switch {
	margin-left: 0;
}

.fuel-recover-err {
	font: 400 13px/1.45 var(--ul-font-body);
	color: var(--ul-lost);
}

.note,
.attention,
.discard-warning {
	display: flex;
	gap: 8px;
	align-items: flex-start;
	font: 400 13px/1.45 var(--ul-font-body);
}

.note {
	color: var(--ul-ink-2);
}

.note .note-icon {
	color: var(--ul-attention);
}

.note-icon {
	flex: none;
	margin-top: 1px;
}

.attention {
	--ul-fill: var(--ul-attention-bg);
	padding: 10px 12px;
	background: var(--ul-fill);
	clip-path: var(--ul-notch-2);
	color: var(--ul-ink);
}

.attention .note-icon {
	color: var(--ul-attention);
}

/* On a lost card the note is the failure's reason, so it takes the lost tone, not the warn band. */
.journal-card[data-status="lost"] .attention {
	--ul-fill: var(--ul-lost-bg);
}

.journal-card[data-status="lost"] .attention .note-icon {
	color: var(--ul-lost);
}

.discard-warning {
	color: var(--ul-lost);
}

.raised-note {
	--ul-fill: var(--ul-raised);
	--ul-notch: var(--ul-notch-2);
	display: flex;
	align-items: flex-start;
	gap: 10px;
	margin: 0;
	padding: 10px 12px;
	font: 400 13.5px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.guide {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 12px;
}

.stage {
	flex: 1 1 24ch;
	margin: 0;
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.stage.act,
.stage strong {
	color: var(--ul-ink);
}

.stage strong {
	font-weight: 700;
}

.summary {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 18px;
}

.took {
	font: 400 14px/1.45 var(--ul-font-body);
	color: var(--ul-ink-2);
}

.mono {
	font-family: var(--ul-font-mono);
	color: var(--ul-ink);
}

.links {
	display: flex;
	flex-wrap: wrap;
	gap: 18px;
	margin-left: auto;
}

.links a {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font: 700 14px/1 var(--ul-font-body);
	color: var(--ul-accent-text);
	text-decoration: none;
}

.links a:hover {
	text-decoration: underline;
	text-underline-offset: 4px;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
}

.actions:empty {
	display: none;
}
</style>
