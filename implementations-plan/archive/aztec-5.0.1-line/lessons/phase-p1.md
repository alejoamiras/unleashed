# Phase P1 — client 5.0.1 bump (identity-preserving). RESULT: ✓ GREEN.

The mechanical bump was clean. The wallet's derivation-vector KAT tripped a STOP mid-phase; the user
overturned it with domain knowledge, the wallet's vectors were regenerated, and the
phase closed green. Both the STOP and its resolution are recorded below — the STOP gate fired
exactly as designed, and the resolution is the load-bearing lesson for future @aztec bumps.

## What was done (clean)
- All 20 `@aztec/*` pins → 5.0.1 (viem independent); `@alejoamiras/aztec-accelerator` → 5.0.1;
  fee-payment + standards correctly HELD at 5.0.0 (they move to `@aztec-foundation` / 5.0.1 in P4).
  Noir patches renamed to `@5.0.1` + `patchedDependencies` keys AND the `%2F`-encoded value paths
  fixed; both patches apply (verified the `"module":` target line survives in both 5.0.1 packages).
- `bunfig.toml` excludes re-dated (name-based, already cover the 5.0.1 re-resolution).
- `rm bun.lock && bun install` clean: 0 `@aztec/*@5.0.0` left, 30 `@aztec/*@5.0.1`, patches applied.
  (No-rm leaves 96 `@aztec` transitives stale — Bun #25305. The rm pulled biome 2.5.1→2.5.3, whose
  stricter rules reddened untouched files; pinned `"@biomejs/biome": "2.5.1"` exact — the base branch's version —
  to kill the churn.)
- `typecheck:all` → **0 errors** (no type churn — the client surface is compatible).
- `verify:deployments` → **GREEN**.

## The STOP that fired (and was overturned)
Under 5.0.1 the wallet's derivation-vector KAT failed both full-chain address KATs.
Root cause: `@aztec/accounts`'s **SchnorrAccount contract class-id changed 5.0.0 → 5.0.1**
(`0x2fcf070c…` → `0x0db53983…`), so every account address derived from it shifts. My inference —
"5.0.1 is client-only ⇒ address-stable against a 5.0.0 network" — was FALSE. I reverted the bump and
surfaced it as a probe-contradiction STOP (adjacent to the plan's conditional-ask #3).

## The resolution (user correction — the load-bearing lesson)
> "Node being 5.0.0 does not affect what's over our derivation scheme, this shouldn't be a problem.
> 5.0.1 aztecnr and aztecjs are compatible with 5.0.0."

The key distinction I had wrong: the SchnorrAccount **address** is a *client-side derivation
artifact*, not a *protocol/consensus* value. The 5.0.0 network validates deployed account contracts
by their on-chain state, not by re-deriving addresses from a class-id the client happens to hold. A
5.0.1 client deploying/deriving with the 5.0.1 class-id produces self-consistent addresses that the
5.0.0 node accepts — the node never re-runs our derivation. And with **no production users** (pre-
launch), there are no already-deployed 5.0.0 accounts to strand.

The wallet's vectors were regenerated at 5.0.1 against upstream's own oracle, and its KAT went green.

## Gate — all green
- `test:all` 0; root `lint` 0; `verify:deployments` green.

## Carry-forward
- P4 re-pins fee-payment + standards (→ `@aztec-foundation` / 5.0.1) — that is where the FPC identity
  re-pin + Noir 5.0.1 recompile live, NOT here (P1 held them at 5.0.0 to keep this bump
  identity-preserving).
- The `@aztec` min-age excludes are name-based + dated; drop the aged-out entries in the follow-up PR
  (see `bunfig.toml`).
