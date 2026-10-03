/**
 * Where the bridged Fee-Juice lands on L2, per fuel mode — the leak-or-strand invariant.
 *
 * PUBLIC fuel commits the user's own Aztec address as the claim recipient (claim_public binds
 * it in the content hash). PRIVATE fuel MUST land at the canonical PrivateFPC: the deposit's
 * consumption secret is deriveBridgeSecret(salt, claimer) and `PrivateFPC.mint_and_pay_fee`
 * re-derives it from msg_sender, so only the claimer can spend it — sending private fuel to
 * any other address strands it; sending public fuel to the FPC links the user on L1 (the
 * router emits fuelRecipient indexed). Extracted so the mapping is testable in isolation
 * from the orchestration that consumes it.
 */
import { PRIVATE_FPC_ADDRESS } from "@unleashed/bridge-core"

export function fuelRecipientFor(isPrivate: boolean, recipient: string): `0x${string}` {
	return (isPrivate ? PRIVATE_FPC_ADDRESS : recipient) as `0x${string}`
}
