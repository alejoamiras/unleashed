import { ref } from "vue"
import { safeSentence } from "@/lib/token-display"

export type ToastKind = "ok" | "error" | "info" | "saved"

type Link = { label: string; href: string }

/** A toast says something: a bold lead, a plain text, or both. */
type Message = { readonly lead: string; readonly text?: string } | { readonly lead?: undefined; readonly text: string }

export type ToastEntry = Message & {
	readonly id: number
	readonly kind: ToastKind
	readonly link?: Link
	/** How long it stays up; the toast draws its countdown over exactly this. */
	readonly ttlMs: number
}

type NewToast = Message & {
	readonly kind: ToastKind
	readonly link?: Link
	readonly ttlMs?: number
}

const DEFAULT_TTL_MS = 6_000
const MAX_QUEUE = 4

const toasts = ref<ToastEntry[]>([])
const timers = new Map<number, ReturnType<typeof setTimeout>>()
let nextId = 1

export function useToast() {
	return {
		toasts,
		push,
		dismiss,
	}
}

function push(toast: NewToast): number {
	const id = nextId++
	const ttlMs = toast.ttlMs ?? DEFAULT_TTL_MS
	const entry: ToastEntry = { ...toast, ...bounded(toast), id, ttlMs }
	// Append to the end; if we exceed MAX_QUEUE, drop the oldest.
	const next = [...toasts.value, entry]
	while (next.length > MAX_QUEUE) {
		const dropped = next.shift()
		if (dropped) clearTimer(dropped.id)
	}
	toasts.value = next

	const handle = setTimeout(() => dismiss(id), ttlMs)
	timers.set(id, handle)
	return id
}

/** Toast text can carry wallet, RPC or backup-file text: bidi controls stripped and capped here, once. */
function bounded(m: Message): Message {
	if (m.lead === undefined) return { text: safeSentence(m.text) }
	return m.text === undefined ? { lead: safeSentence(m.lead) } : { lead: safeSentence(m.lead), text: safeSentence(m.text) }
}

function dismiss(id: number): void {
	clearTimer(id)
	toasts.value = toasts.value.filter((t) => t.id !== id)
}

function clearTimer(id: number): void {
	const handle = timers.get(id)
	if (handle !== undefined) {
		clearTimeout(handle)
		timers.delete(id)
	}
}

/** Test-only: clear state between cases. */
export function __resetToastsForTests(): void {
	for (const handle of timers.values()) clearTimeout(handle)
	timers.clear()
	toasts.value = []
	nextId = 1
}
