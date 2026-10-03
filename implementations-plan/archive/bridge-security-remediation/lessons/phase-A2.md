# Phase A2 — F-007: bearer-secret integrator contract (PR A)

**Done (docs-only, no behavior change).**
- **Verified:** bridge-core never logs/persists the plaintext secret — `rg 'console|log(' flows.ts private-fuel.ts | grep secret` is empty. The hooks forward `secretHex`/`tokenSecretHex`/`fuelSecretHex` to the CALLER (`flows.ts:48,65,238,281`); bridge-core itself is clean. The integrator is the trust boundary.
- **Documented:** added a SECURITY (F-007) block to the `RecoveryHooks` + `SwapRecoveryHooks` TSDoc and a bullet in `packages/bridge-core/README.md` — a PRIVATE claim is bearer (content hash omits the recipient → whoever holds the secret can claim to anyone); integrators MUST seal at rest, NEVER log/URL/plaintext-persist; a leak makes the deposit→claim window front-runnable. Recipient-commitment (on-chain recipient binding) is explicitly backlog.

**Validation gate (passed):** `bun run --cwd packages/bridge-core test` → 16 files, 109 passed; `flows.ts` Biome-clean.
