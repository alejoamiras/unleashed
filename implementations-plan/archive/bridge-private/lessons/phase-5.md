# PV5 — final gates (lessons)

## codex post-impl audit (kicked off)
PV1–PV4 are code-complete + green (lint, typecheck, 142 faucet tests, build). Kicking off the codex post-impl security/correctness audit of the WHOLE private-flow surface before declaring done (the loop's PV5 step).

Audit scope: the seal (bearer-secret leak paths, per-record key, self-test), the deposit recipient-binding guard, the withdraw authwit (nonce replay, atomicity), cross-flow state confusion. Files: `useDeposit.ts`, `useWithdraw.ts`, `recovery-crypto.ts`.

**Verdict (codex `019eacad`):**
- **CRITICAL** — single-pending storage: a 2nd deposit overwrites the 1st's recovery record → for private, the ONLY sealed bearer blob + leafIndex is lost → unrecoverable. → **FIXED**: `deposit()` blocks while a pending exists + DepositCard button disabled when `hasPending`.
- **HIGH** — the resumed claim's recipient comes from MUTABLE localStorage and is the actual `claim_private` recipient → storage tamper redirects the claim. → **SURFACED (design call)**: authenticate the persisted `{recipient, amount, leafIndex}` with the recovery key (seal/MAC the metadata, or seal the recipient INTO the blob). Practical risk needs localStorage write (XSS/local).
- **HIGH** — completion inferred from aggregate `balance_of_private >= pre+amount` → an unrelated private-balance change can clear the record prematurely (or short-circuit before claim). → **SURFACED (design call)**: confirm via the specific claim tx / message consumption. This is the SHARED public+private heuristic (public is testnet-validated) — a rework risks the public flow.
- **MEDIUM** — verbose logs always on; resume logs `sealedSecret` + `secretHashHex`; failures log raw errors. → **DEFERRED** to the user's security-hardening pass (logging was explicitly deferred). The blob is encrypted, not plaintext.
- **MEDIUM** — self-test only proves same-message-twice-now; `chainId` hardcoded `sepolia`. → **SURFACED**: persist + verify the actual L1 account + chain id used for sealing.
- **Looks fine** — no plaintext bearer secret persisted; per-record key domain-separation sound; withdraw authwit tightly scoped to `BRIDGE_PROXY` + the exact `burn_private` call, burn+exit atomic.

Disposition: the CRITICAL is fixed this pass. The two HIGHs + the chain/account MEDIUM touch the SHARED recovery design (public + private) — surfaced to the user as a hardening decision rather than autonomously reworking the testnet-validated public flow (per the "codex is advisory; don't expand approved scope" rule).

## Not autonomous (the user's final steps)
- `/code-review max --fix` — interactive guided tour; the user drives it.
- Manual testnet tests for PV1 (private deposit) + PV2 (private withdraw) — signature-gated; see `lessons/phase-1.md` + `phase-2.md` for the expected flows.
