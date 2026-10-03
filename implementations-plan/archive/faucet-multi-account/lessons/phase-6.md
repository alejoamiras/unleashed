# Lessons — Phase 6 (account labels on history cards, Options 1+2)

## Outcome
Green: typecheck 0 · lint 0 · test:faucet 587/587. Deposit cards carry always-on account tags; other-granted-account cards swap their guarded actions for a busy-gated SWITCH TO <label>; shared `switchActiveAccount()` unifies the switcher-menu and card switch paths. Codex round: conditional approve → both MED conditions + alias LOW folded → confirmation round.

## Keepers

1. **The mockup lied about withdraws.** It showed a labeled AZTEC → ETHEREUM card; implementation revealed `WithdrawJournalRecord` persists only `recipientL1` — the Aztec sender is captured for the burn but never written. Corrected in the mockup rather than silently dropped. When mocking against a schema, check the RECORD SHAPE per direction, not just the pretty case. Follow-up candidate: additive `senderL2` field (bridge-core) tags future withdraws; historic ones stay untagged by the additive-loader convention.
2. **Persisted state is input**: the journal loader accepts any object with a string id + valid direction — a tampered localStorage record with `recipient: 42` survives loading and reached `.toLowerCase()` in the new render path (codex MED). Card-level type guard + engine fail-closed both added. Any NEW read of journal fields must assume runtime shape, not TS shape.
3. **Gate every affordance on the state that makes its action possible**: the switch button called `selectAccount`, which rejects unless `status === "connected"` — during setting-up the button was an enabled no-op (codex MED). If a handler has a precondition, the CONTROL needs the same precondition.
4. **Zero-widths weren't in the bidi strip set** (U+200B-200D, U+FEFF) — a "visually empty but truthy" alias defeated every `alias || fallback`. Strip + trim at parse time fixes all consumers at once; that's the payoff of sanitizing at the boundary instead of per-render.
5. Test-mock seams: mocking `useWalletConnection` with ONLY `switchActiveAccount` works because the card imports nothing else from it — but the useBridgeWallet mock needed `status` added the moment offerSwitch read it. Mocks that mirror a module's surface must grow WITH the surface; the typecheck catches missing refs only if the component dereferences them at setup.
