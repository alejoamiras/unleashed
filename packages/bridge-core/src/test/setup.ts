// @alejoamiras/nulo-wallet-crypto reads `self.crypto`; vitest's node env exposes
// `globalThis.crypto` (Web Crypto) but not `self`. Alias it so the AES-GCM
// round-trip works without pulling in jsdom.
const g = globalThis as unknown as { self?: unknown }
if (g.self === undefined) {
	g.self = globalThis
}
