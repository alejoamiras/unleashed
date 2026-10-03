# Relayer script — key-handling review

Phase 9 scope item: "relayer script key handling". The relayer was written this phase as the concrete
demonstration of the recipient-commitment capability (the driver of the whole change), split into:

- `packages/bridge-core/src/relay-claim.ts` — the PURE, node-free core (descriptor parsing, key loading,
  salt-v2 fail-closed, log redaction). Unit-tested (`relay-claim.test.ts`, 13 cases).
- `packages/bridge-core/scripts/relay-claim-testnet.ts` — the thin live wiring (wallet, sponsored FPC,
  the send). LIVE-ONLY; runnable only after the Phase 6/7 cutover.

## Threat model

A relayer finishes a user's PRIVATE token `claim_private` FOR them. Recipient-commitment means a wrong
recipient derives a different consumption secret and can't consume — so the relayer **cannot redirect or
skim**. What a malicious/compromised relayer CAN do: (a) grief (not submit — the user can always self-
claim), (b) learn the salt (it necessarily receives it) → a recipient↔amount↔leaf privacy linkage.
So the salt is a **linkage-privacy credential**, not a bearer/theft credential.

## Key-handling properties (verified)

| Property | Where | Verified |
|---|---|---|
| Relayer runs under its OWN dedicated key, never the user's | `requireRelayerSecret(env)` reads `RELAYER_L2_SECRET_KEY` | ✅ test |
| Missing/zero/unparseable key → fail-closed (no run) | `requireRelayerSecret` throws | ✅ 3 tests |
| Raw key never returned/logged/in a thrown message | returns `Fr`; catch swallows the raw value | ✅ test (junk key not echoed) |
| Salt never logged | `redactDescriptorForLog` → `salt: "<redacted>"`; top-level catch prints `err.message` only | ✅ test |
| Descriptor fail-closed on any malformed field | `parseClaimDescriptor` validates bridge/recipient/amount>0/salt/leafIndex | ✅ 6 tests |
| Malformed-salt error does not echo the salt | `parseClaimDescriptor` throws before `Fr.fromString`; message asserted salt-free | ✅ test |
| Refuses a non-recipient-committed deployment | `assertSaltV2(manifest)` throws unless `privateClaimMode === "salt-v2"` | ✅ 2 tests |
| `tokenPortal`/bridge sourced from the trusted manifest, not user input | script rebuilds the bridge instance from the manifest + asserts it equals the descriptor's `bridge` | ✅ read |
| Fees via sponsored FPC (relayer needs no Fee Juice; no funded key) | `SponsoredFeePaymentMethod` | ✅ read |

## Notes

- `assertSaltV2` correctly **refuses to run against today's live testnet** (`testnet-bridge.json` has
  `privateClaimMode: undefined` — the pre-cutover bearer deployment). This is the fail-closed design; the
  relayer becomes usable only after the Phase 6/7 cutover writes a salt-v2 manifest.
- The live send mirrors the proven sandbox-smoke pattern (`deploy-sandbox.ts:336-362`): `.send({wait:
  {waitForStatus}})` auto-waits and throws on failure; success is "no throw". The sandbox smoke ALSO
  proves the negative (a wrong-recipient `claim_private` is rejected before consuming), so the redirect-
  proof is exercised end-to-end there.
- The script cannot be integration-tested offline (no live salt-v2 deployment yet); its pure core is
  fully unit-tested and it typechecks. Live exercise is a Phase 7 step, gated on explicit go.

## Live-wiring review (wrap-up code-review pass — the wrapper was written after the audit fan-out)

The live wrapper escaped the Phase 9 audit subagents (written after they ran). Two review rounds:

1. **Main-agent read vs the proven `fuel-testnet.ts` pattern** found the account API was misused:
   `createSchnorrAccount` returns a MANAGER, not a wallet — fixed to `manager.getAccount().getAddress()`
   for the tx `from`, contracts bound to the `EmbeddedWallet`, and a deploy-if-needed gate
   (`node.getContract(addr)` → sponsored-FPC deploy, deterministic `Fr.ZERO` salt).
2. **Codex xhigh** (session 019f3879-4876-7e80-aed7-83412a5196f1) confirmed the corrected account gate,
   the `deployMethod.send({from:"NO_FROM"})` idiom, the `ewallet` binding, and that a waited send returns
   a real `receipt.txHash`. It found ONE real bug: `claim_private` privately calls
   `TokenMinterProxy.mint_to_private` → the Token, so a clean PXE needs the **proxy + token** artifacts
   registered, not just the bridge. Fixed — the wrapper now rebuilds + registers all three from the
   manifest (mirroring `fuel-testnet.ts:135-165`). Added a bounded 5×/15s claim retry for the L1→L2
   settling window.

Net: the relayer's security-relevant logic (key handling, salt-v2 refusal, redirect-proof) is unit-tested
and audited; the remaining live-only wiring is now matched line-for-line to the proven testnet scripts and
codex-verified. Its first real exercise is the gated Phase 7 run.
