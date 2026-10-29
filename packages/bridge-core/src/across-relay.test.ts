import { type Hex, keccak256, pad } from "viem"
import { expect, it } from "vitest"
import { type AcrossRelayData, acrossRelayHash, type FilledRelayIdentity, fillsRelay } from "./across-relay"

const relay: AcrossRelayData = {
	depositor: pad("0xd0"),
	recipient: pad("0x51cd"),
	exclusiveRelayer: pad("0x7a4f"),
	inputToken: pad("0x036c"),
	outputToken: pad("0x1c7d"),
	inputAmount: 4_000_000n,
	outputAmount: 3_000_000n,
	originChainId: 84532n,
	depositId: 42n,
	fillDeadline: 1_800_000_000,
	exclusivityDeadline: 1_800_000_000,
	message: "0xc0ffee",
}
const hash = acrossRelayHash(relay, 11155111)
const { message, ...fields } = relay
const fillOf = (over: Partial<FilledRelayIdentity>): FilledRelayIdentity => ({ ...fields, messageHash: keccak256(message), ...over })

it("matches a fill of the relay itself, never another relay reusing its origin and deposit id", () => {
	expect(fillsRelay(fillOf({}), message, hash, 11155111)).toBe(true)
	const stranger: Partial<FilledRelayIdentity> = { recipient: pad("0xbad"), exclusiveRelayer: pad("0x0"), messageHash: pad("0x0") }
	expect(fillsRelay(fillOf(stranger), message, hash, 11155111)).toBe(false)
	expect(fillsRelay(fillOf({ recipient: pad("0xbad") }), message, hash, 11155111)).toBe(false)
	expect(fillsRelay(fillOf({ messageHash: keccak256("0x00" as Hex) }), message, hash, 11155111)).toBe(false)
	expect(fillsRelay(fillOf({}), message, hash, 1)).toBe(false)
})
