# Phase 5 — faucet single-path UI + salt-v2 reader

**Status: ✅ COMPLETE — `bun run audit:faucet` GREEN (typecheck:all 0 · test:faucet 426 · lint 0 · verify:deployments OK · build ✓).**

## All pieces done

1. `bridge-deployments.ts` — required `BRIDGE_ROUTER`/`BRIDGE_PERMIT2`/`BRIDGE_SWAP_TARGET` (C7) + `PRIVATE_CLAIM_MODE`/`SUPPORTS_SALT_V2` (L9 interlock) + `bridge-deployments.test.ts` client-pin (witness addresses are manifest-sourced only — codex cond. 4).
2. `useDeposit.ts` — bridge-only via `router.bridge()` (Permit2 witness, fuel fields zeroed); private derives the committed secret from a recipient-bound salt; L9 salt-v2 guard. The shared secret-setup change covers the fueled-private token leg too.
3. `useFuel.ts` — fuel-only via `router.bridge(tokenPortal = FeeJuicePortal, isPrivate = false)` + one-time `approve(Permit2, max)`; kept `verifyPortalAsset` + `parseFeeJuiceDeposit`.
4. `bridge-steps.ts` — SIGN-everywhere; fuel-only keeps a conditional one-time APPROVE; stepper + component tests updated.
5. `flows.ts` — DELETED `runDeposit`/`depositPublic`/`depositPrivate` + `DepositParams`/`DepositFlowStage`/`InboxAbi`; grep-gates pass (no direct-portal write in src/faucet; every `claim_private` site passes the stored secret = the salt for private).

## Gotchas

- **TS re-widens imported (ESM live) bindings to `| undefined` across `await`** — capture guarded config (`BRIDGE_ROUTER` etc.) into LOCAL consts before using them past an await (useFuel).
- **`bunx biome check <single-file>` bypasses `biome.json` `overrides`** (which disable `useArrowFunction` for `*.test.ts`), giving FALSE `useArrowFunction` findings. NEVER `biome check --fix` those test mocks — the `vi.fn(function(){…})` form is REQUIRED (they're `new`-instantiated; the arrow autofix breaks them). Always verify lint via `bun run lint` (repo config), not per-file checks.

## Remaining for later phases (not Phase 5)

- The live testnet scripts `deposit-testnet.ts`/`fuel-testnet.ts` still use the old direct-portal path — rewired at the Phase 7 canaries (live-only).

## Done (committed — 423 faucet tests green, typecheck + lint clean)

- `apps/faucet/src/contracts/bridge-deployments.ts` — `BRIDGE_ROUTER`/`BRIDGE_PERMIT2`/`BRIDGE_SWAP_TARGET` promoted to required bridge config (C7); `PRIVATE_CLAIM_MODE`/`SUPPORTS_SALT_V2` reader (L9 interlock).
- `packages/bridge-core/src/index.ts` — re-exports `./claim-secret` (so the faucet can import `deriveTokenClaimSecret`).
- `apps/faucet/src/composables/useDeposit.ts`:
  - **The shared secret setup** (the ~line-637 block, used by BOTH the fuel + non-fuel branches): private deposits now compute `committedSecret = deriveTokenClaimSecret(salt, recipient)` and commit `computeSecretHash(committedSecret)`; the stored/claimed value (`secret`) IS the salt. Because the claim side already passes the record's stored secret as `claim_private`'s 3rd arg, **the claim needed no change** — it now passes the salt and the circuit re-derives. This one change covers the fueled-private token leg too.
  - **L9 salt-v2 interlock**: refuses a private deposit unless `SUPPORTS_SALT_V2` (manifest declares `privateClaimMode: "salt-v2"`).
  - **Non-fuel branch rewired** from `approve` + `depositToAztec{Public,Private}` to a Permit2 witness (fuel fields zeroed, `tokenSecretHash = id`) → `router.bridge()`, reading the leaf/key from the router `Bridge` event. Removed the now-unused `InboxAbi`/`TokenPortalAbi` import.

## Key design insight

The salt threads through the EXISTING `secret` field of the record/sealed-envelope/claim. For private, that field holds the `claim_salt` (not a random preimage); the L1-committed `secretHash` is over the derived secret. So the deposit-side computation is the only real change — the seal, journal, recovery, and claim machinery are untouched.

## Remaining (next loop firings)

1. **`useFuel.ts`** (fuel-only tab): rewire `approve(FeeJuicePortal)` + `FeeJuicePortal.depositToAztecPublic` → one-time `approve(Permit2, max)` + a Permit2 witness → `router.bridge(tokenPortal = FUEL_PORTAL, bridgeToken = FUEL_ASSET, isPrivate = false)`. Keep `parseFeeJuiceDeposit` for the leaf/received (C9 — parse the FJ portal event, not the router `Bridge` event). NOTE: the fee-asset approve is via the `useL1FeeAsset` composable whose spender is the portal — switching it to Permit2 needs a composable tweak.
2. **`bridge-steps.ts`**: SIGN-everywhere for token records; fuel records get a conditional one-time APPROVE + SIGN; bump new deposit records to `schema: 3`.
3. **`flows.ts` direct-path DELETION** (the deferred Phase 3 piece): delete `runDeposit`/`depositPublic`/`depositPrivate`; update `deposit-testnet.ts`/`fuel-testnet.ts`/`smoke-existing-testnet.ts` + `flows.test.ts`; run the no-direct-write grep + the 5-site `claim_private` stale-semantics grep (C2/M1).
4. **Client-pin test** (tokenPortal/token/router/permit2 come only from the manifest — codex cond. 4).

## Gate — partial

`bun run test:faucet` 423 passed · `bun run --cwd apps/faucet typecheck` clean · `bun run lint` clean. Full Phase 5 gate (`bun run audit:faucet` incl. build + verify:deployments) runs once fuel-only + steps land.
