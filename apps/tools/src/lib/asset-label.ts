import { type BridgeJournalRecord, assetKindOf, isSendRecord } from "@unleashed/bridge-core"
import { formatStoredAmount, isStoredAmount } from "@/lib/format"
import { safeDisplay } from "@/lib/token-display"

/** The journal's asset discriminant (mirrors `@unleashed/bridge-core`'s `assetKindOf` return). */
export type AssetKind = "bridge-token" | "fee-juice"

/** The display identity a record carries for its own token — any ERC-20, not one deployment's. */
export interface AssetBlock {
	displaySymbol: string
	decimals: number
}

/** A record predating the generation carries no token identity of its own; it can only be named
 *  generically, and it can never run here (its deployment binding no longer matches). */
const UNKNOWN_SYMBOL = "TOKEN"
const UNKNOWN_DECIMALS = 18

/**
 * Display symbol for a bridged asset. A gas-only bridge carries Aztec Fee Juice, NOT a token — per
 * the gas-naming convention its L2-surface name is "FJ" public / "Private FJ" private ($AZTEC is
 * only the L1-side name).
 */
export function assetSymbol(assetKind: AssetKind | undefined, isPrivate: boolean, token?: AssetBlock): string {
	if (assetKind === "fee-juice") return isPrivate ? "Private FJ" : "FJ"
	return token?.displaySymbol ?? UNKNOWN_SYMBOL
}

/** Decimals for a bridged asset. Fee Juice is the 18-decimal protocol standard; a send uses its own
 *  token block's decimals. An amount formatted at the wrong decimals shows a wildly wrong number. */
export function assetDecimals(assetKind: AssetKind | undefined, token?: AssetBlock): number {
	if (assetKind === "fee-juice") return 18
	return token?.decimals ?? UNKNOWN_DECIMALS
}

/** A record's own token identity: present on every schema-3 send except a gas-only one. */
export function recordTokenBlock(rec: BridgeJournalRecord): AssetBlock | undefined {
	return isSendRecord(rec) ? rec.token : undefined
}

/** A record's amount as every surface shows it: the base-unit string, its decimals, the symbol
 *  (already stripped and capped), and whether the figure is only a floor. */
export interface DisplayAmount {
	raw: string
	decimals: number
	atLeast: boolean
	symbol: string
	/** Fee Juice as bridged: claim fees come out of it after it lands, so it is not what is left to spend. */
	gross: boolean
}

/**
 * A gas-only send's `amount` is the token it paid, not what it bridged, so it shows its Fee Juice:
 * the exact figure once the deposit event reported it, else the signed floor. That figure is gross,
 * and every surface that presents it as arrived says so with `amountQualifier`.
 */
export function displayAmountOf(rec: BridgeJournalRecord): DisplayAmount {
	const kind = assetKindOf(rec)
	if (isSendRecord(rec) && kind === "fee-juice") {
		const fuel = rec.direction === "deposit" ? rec.fuel : undefined
		const symbol = assetSymbol(kind, rec.isPrivate)
		if (fuel?.received !== undefined) return { raw: fuel.received, decimals: 18, atLeast: false, symbol, gross: true }
		return { raw: fuel?.minOutput ?? "", decimals: 18, atLeast: fuel?.minOutput !== undefined, symbol, gross: true }
	}
	const token = recordTokenBlock(rec)
	return {
		raw: rec.amount,
		decimals: assetDecimals(kind, token),
		atLeast: false,
		symbol: safeDisplay(assetSymbol(kind, rec.isPrivate, token)),
		gross: false,
	}
}

/** What left the wallet: a token + gas deposit's token claim plus the slice it swapped for gas, as its review
 *  showed it. A gas-only send and a withdrawal read as `displayAmountOf`. */
export function sentAmountOf(rec: BridgeJournalRecord): DisplayAmount {
	const d = displayAmountOf(rec)
	const slice = rec.direction === "deposit" && !d.gross ? rec.fuel?.amount : undefined
	if (slice === undefined || !isStoredAmount(slice) || !isStoredAmount(d.raw)) return d
	return { ...d, raw: (BigInt(d.raw) + BigInt(slice)).toString() }
}

/** The figure alone: "≥ " before a floor, "—" when there is nothing to show. */
export function displayAmountText(d: DisplayAmount): string {
	const figure = formatStoredAmount(d.raw, d.decimals)
	return d.atLeast && figure !== "—" ? `≥ ${figure}` : figure
}

/** The words a gross figure carries wherever it is shown; null when the figure is what arrived. */
export function amountQualifier(d: DisplayAmount): string | null {
	return d.gross ? GROSS_QUALIFIER : null
}

/** Said beside any Fee Juice figure counted as bridged, since claim fees come out of it later. */
export const GROSS_QUALIFIER = "before claim fees"
