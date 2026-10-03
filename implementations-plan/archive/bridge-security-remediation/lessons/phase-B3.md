# Phase B3 — F-002: immutable single-minter proxy (PR B)

**Done (source + wiring; artifact regen deferred to B4).**
- `token_minter_proxy/main.nr` redesigned: removed the `can_mint` Map + `set_minter` (owner could authorize any minter) + `is_minter`/`assert_minter(minter)` + the `Map`/`PublicMutable` imports. Added `bridge: PublicImmutable<AztecAddress>`, set ONCE via the owner-gated single-shot `set_bridge` (PublicImmutable.initialize reverts on a 2nd call). `mint_to_*`/`burn_*` (public) assert `bridge == msg_sender`; (private) `enqueue_self.assert_bridge(msg_sender)` (kept the enqueue pattern — the lowest-risk faithful mirror of the original, now reading the immutable `bridge`). Added `get_bridge` view. After `set_token` + `set_bridge`, the owner has ZERO standing authority — a compromised owner key can neither mint nor add a minter (F-002 closed).
- Wiring: `deploy-sandbox.ts` / `deposit-testnet.ts` / `deploy-bridge-testnet.ts` `proxy.set_minter(bridge, true)` → `proxy.set_bridge(bridge)` (+ doc comments). Required so B3's own deploy/smoke path doesn't call the removed `set_minter`.

**Validation gate (compile passed; smoke → B5):** `bash packages/bridge-aztec/scripts/compile.sh` → both `token_minter_proxy` + `token_bridge` compile + AVM-transpile (rc.2 `aztec` CLI + `bb`). The `deploy:sandbox --smoke` (mint-on-claim / burn-on-exit e2e) needs a LIVE sandbox (none running this session) → consolidated into B5's dedicated pre-live gate (which already runs `deploy-sandbox --smoke` on the full new stack).

**Artifact decision:** the recompile regenerated `target/*.json` (proxy ABI changed: get_bridge/set_bridge, no set_minter). DISCARDED for now — committing the new proxy artifact pre-cutover would drift it from the deployed OLD proxy + the committed `testnet-bridge.json`, breaking the faucet's reconstruction. The artifact regen + commit is coupled with **B4** (candidate config + new addresses) so source ↔ artifact ↔ config move together. B3 commits source + wiring only; the compile already proved the source builds.

**Failure log:** attempt 1 — a non-ASCII em-dash in the header comment tripped Noir ("Invalid comment character: only ASCII"). Fixed (ASCII-only comments). 1/5.

**Held local** (public repo, PR-B disclosure).
