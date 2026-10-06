import type { ActivityRowModel } from "@/composables/useActivityFeed"

/** A needs-you CLAIM row; override what the case is about. Status follows the group unless given. */
export function rowModel(over: Partial<ActivityRowModel> = {}): ActivityRowModel {
	const group = over.group ?? "needs-you"
	return {
		id: "rec-1",
		createdAt: 1,
		direction: "deposit",
		status: group === "other-account" ? "needs-you" : group,
		group,
		action: "claim",
		foreground: false,
		switchTarget: null,
		phase: "Claim",
		amount: "0.5",
		symbol: "WETH",
		qualifier: null,
		route: "Ethereum → Aztec",
		visibility: "public + gas",
		age: "26 min",
		ageSpoken: "26 minutes ago",
		counts: group === "needs-you" && !over.foreground,
		...over,
	}
}
