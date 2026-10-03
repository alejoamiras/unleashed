# JS light pass — L1 signing-payload builders (bridge deposit/fuel)

**Scope:** `packages/faucet/src/composables/useDeposit.ts`, `packages/bridge-core/src/{flows,private-fuel}.ts`, `packages/bridge-core/src/journal.ts` (secret/witness/recipient handling only). Also read for verification: `bridge-core/src/{l1,route,quote,recovery-crypto}.ts`, `bridge-core/src/l1.test.ts`, `bridge-evm/src/SwapBridgeRouter.sol`, `bridge-evm/test/WitnessHash.t.sol`, `faucet/public/testnet-bridge.json`, and the installed `@aztec/foundation` + `@aztec/bb.js` RNG.

**Verdict: no fund-relevant JS findings.** Every load-bearing path the prompt flagged checks out. One non-fund hardening note (drift-detection, not a live bug) at the bottom.

---

## Checklist results (all CLEAN — traces below)

### 1. Witness DRIFT vs Solidity TYPEHASH field order — CLEAN

The Solidity `BRIDGE_WITNESS_TYPEHASH` (`SwapBridgeRouter.sol:52-55`) and `BRIDGE_WITNESS_TYPE_STRING` (`:56`) declare the eleven fields as:

`tokenPortal, bridgeToken, totalAmount, fuelAmount, aztecRecipient, fuelRecipient, tokenSecretHash, fuelSecretHash, minFuelOutput, routeHash, isPrivate`

All three JS surfaces match this order AND the per-field ABI types **exactly**:
- `BRIDGE_WITNESS_TYPE` string — `bridge-core/src/l1.ts:11-12` (identical string to the Solidity TYPEHASH literal).
- EIP-712 member list `BRIDGE_WITNESS_PERMIT_TYPES.BridgeWitness` — `l1.ts:87-99` (address/address/uint256/uint256/bytes32/bytes32/bytes32/bytes32/uint256/bytes32/bool).
- `hashBridgeWitness` abi.encode order — `l1.ts:119-152`.

Route hashing matches too: `hashRoute` (`l1.ts:40-59`) encodes `tuple[](currency0 address, currency1 address, fee uint24, tickSpacing int24, hooks address)` + `bool[]`, byte-identical to `_hashRoute` (`SwapBridgeRouter.sol:344`). `fee` is `uint24` and `tickSpacing` is `int24` on both sides (a common mismatch spot — checked, correct).

**Binding is enforced on-chain, not trusted:** the router recomputes `routeHash: _hashRoute(p.path, p.zeroForOnes)` from the *submitted* path and rebuilds the full witness from submitted params (`SwapBridgeRouter.sol:167-179`), then Permit2 verifies it against the signature (`:311`). The JS submits the same `path`/`zeroForOnes` it hashed into the signed `routeHash` (`useDeposit.ts:652` signs `hashRoute(fuelPre.route.path, fuelPre.route.zeroForOnes)`; `:681-682` submits the same `fuelPre.route.path`/`zeroForOnes`). A relayer altering recipients/amounts/route/secretHashes after signing ⇒ recomputed witness diverges ⇒ Permit2 reverts. No signed-one / submit-another gap.

Cross-pin test exists: `l1.test.ts:25-44` asserts `hashRoute`/`hashBridgeWitness` equal the fixed reference values produced by `bridge-evm/test/WitnessHash.t.sol`, and `:48-56` asserts the EIP-712 member list is structurally derived from the TYPEHASH string (so the two JS representations can't silently diverge from each other). (Caveat: see hardening note — the Solidity test only logs, doesn't assert, so the *Solidity→TS* direction is a manual re-pin.)

### 2. SECRET quality (bearer secret RNG) — CLEAN (CSPRNG confirmed)

The token bearer secret is `Fr.random()` (`useDeposit.ts:546`, `flows.ts:61,256`). The private-fuel secret is `deriveBridgeSecret(salt, claimer)` where `salt = Fr.random()` (`useDeposit.ts:535-536`). Traced `Fr.random` → `random(Fr)` → `@aztec/foundation` `randomBytes` → `@aztec/bb.js`:
- **Browser (faucet runtime):** `crypto.getRandomValues` — Web Crypto CSPRNG (`@aztec/bb.js/dest/browser/random/browser/index.js`).
- **Node (scripts/tests):** `crypto.randomBytes` — Node CSPRNG (`@aztec/bb.js/dest/node/random/node/index.js`).

The only non-CSPRNG path is `RandomnessSingleton` deterministic mode, gated solely by `process.env.SEED` (`@aztec/foundation/dest/crypto/random/randomness_singleton.js`). That env var cannot be set from a browser and is documented test-only — **not reachable in the faucet**. The Permit2 `nonce` is `BigInt("0x"+crypto.randomUUID without dashes)` (`useDeposit.ts:638`), a 128-bit CSPRNG-derived unordered nonce (Permit2 supports unordered nonces) — no predictability, no collision concern.

Confidence: high. The secret is unpredictable; the front-run-the-claim premise does not apply to the secret-generation step.

### 3. minFuelOutput / slippage floor — CLEAN (cannot sign ~0)

`minOutputForSlippage(quote, bps)` (`quote.ts:93-98`) = `quote * (10000 - bps) / 10000`, with guards: throws if `quote <= 0` and if `bps` is outside `[0, 10000)`; floors to `1n` if integer division underflows. Configured `slippageBps = 300` (3%, `testnet-bridge.json`). A larger `bps` only *tightens* toward `quote`; `bps=0` would set the floor equal to the quote (strictest, not loosest). The dangerous direction (floor → ~0) requires `bps` near 9999 — out of the realistic config and still a deliberate config choice, not a code path.

Two independent pre-signature gates prevent signing away the fuel slice:
- `quoteFuelPath` rejects a zero/empty quote at every hop (`quote.ts:73,87`) — `QuoteUnavailableError`, no silent 0.
- `useDeposit.ts:526-529` requires the live quote itself to clear `BRIDGE_FUEL.minFuelFj` *before* building the witness; a too-thin quote throws and nothing is signed. Comment at `:530-533` documents the "quote-required, never sign with a junk floor" invariant and the code enforces it.

The claim side uses the **event-sourced** `fuelReceived` (`useDeposit.ts:715` reads `fe.args.fuelAmount` from the `BridgeWithFuel` event), never the display quote — matches the content-hash law. No sandwich-drains-the-slice path in the JS.

### 4. Recipient binding — CLEAN

`aztecRecipient` is the connected Aztec account (`useDeposit.ts:645`, `recipient = bridgeWallet.selectedAccount.value`), carried unchanged into both the signed witness (`:645`) and the submitted args (`:676`). `fuelRecipient` is correctly conditional (`:648`): `PRIVATE_FPC_ADDRESS` for private fuel (claimer-bound by the derived secret), the user's L2 address for public fuel — and the *same value* flows into both the signed witness and the submitted call (`:677`). Because the router rebuilds and Permit2-verifies the full witness from submitted params (see #1), there is no "sign recipient A / deposit to recipient B" gap: a divergence reverts. For the non-fuel path, `depositArgs` passes `recipient` for public and omits it for private (`useDeposit.ts:773`), matching the portal ABI (private content hash omits recipient by design — the documented bearer model).

### 5. Secret storage / leak; deadline / nonce — CLEAN

- **Private bearer secret is NOT stored in plaintext.** The journal record sets `secret: isPrivate ? undefined : secret.toString()` (`useDeposit.ts:568`); for private deposits the authoritative secret lives only in the AES-GCM `sealedEnvelope` (`recovery-crypto.ts` — PBKDF2 + AES-GCM via `@alejoamiras/nulo-wallet-crypto`, per-record key derived from a domain-separated L1 signature, `recovery-crypto.ts:27-33,72-86`). `journal.ts:96-104` documents and enforces this split (`secret?` is "PUBLIC only").
- **Same-session secret cache is in-memory only.** `cacheSecret` writes to a module-level `Map` (`useBridgeJournal.ts:124,224-225`), never to `localStorage`, and is cleared on lock (`:207`). The persisted journal (`journal.ts:175-177`, `JOURNAL_KEY`) is the only thing written to `localStorage` and it does not carry the private bearer secret.
- **No secret/salt logging.** The `[bridge:deposit]` logger (`useDeposit.ts:60`) is called only with ids, stages, and tx hashes; a grep for `console.*` of `secret|salt|preimage|privatekey` across `faucet/src` + `bridge-core/src` (excluding tests) returns nothing. No secret in any URL (no query-param / location write of secret material found).
- **Public-deposit secret is plaintext in the journal by design** (`useDeposit.ts:568` sets it) — acceptable: the public content hash binds recipient+amount, so the secret only gates *who triggers* the claim and a local-storage reader cannot redirect funds. Same reasoning for `fuel.secret` (recipient-bound, `journal.ts:63`).
- **Private-fuel `bridgeSecretSalt` + `fpc` are plaintext in the journal** (`useDeposit.ts:578,716`; `journal.ts:82-89`). This is a known/documented "display/recovery hint" — the authoritative copy is sealed. It is **not** a fund leak: the private-fuel secret is `poseidon2([salt, claimer], DOM_SEP)` (`private-fuel.ts:51-52`) and is only consumable via `PrivateFPC.mint_and_pay_fee`, which re-derives it from the *claimer's* `msg_sender`. An attacker who reads the salt from a victim's localStorage still cannot mint+pay as the victim (they aren't `msg_sender`); worst case is a privacy hint, not theft. (Privacy-of-localStorage is out of this fund-focused light scope; flag for the team only if private-bridge unlinkability is a stated guarantee against a local attacker.)
- **Deadline / nonce:** deadline = `now + 1800s` (30 min, `useDeposit.ts:639`), bound in the typed data (`l1.ts:103-116`) and passed identically to the contract call (`useDeposit.ts:685`). Nonce is the 128-bit random above. Both are bound by Permit2's signature; replay across routers/chains is blocked by the Permit2 domain (`{ name: "Permit2", chainId, verifyingContract: permit2 }`, `l1.ts:105`) + `spender = router` in the message (`useDeposit.ts:656`). No deadline-of-0 / max-deadline path.

---

## Non-fund hardening note (NOT a finding — no live bug)

**Witness cross-pin is one-directional / manual.** `WitnessHash.t.sol:53-56` only `console2.log`s `ROUTE_HASH`/`WITNESS_HASH`; it does **not** `assertEq` them against the TS constants. The TS test (`l1.test.ts:16-17`) hardcodes values a human copied from that Solidity log. Consequence: if someone reorders/renames a field in the Solidity `BRIDGE_WITNESS_TYPEHASH`, the Foundry test still passes (it just logs different bytes), and **only** the TS test fails — and only because the TS constants are stale, not because anything cross-checks Solidity↔TS automatically. Field order is *currently* correct, so there is no fund bug today; this is purely a drift-detection gap.

- Impact factors: a future Solidity edit silently passes its own suite; the mismatch surfaces only via the TS unit test (which gates `Quality / Status`, so it would be caught pre-merge — hence low real-world risk). No direct fund path.
- Exploitability: none directly; requires a separate future code change to introduce the drift.
- Confidence: high (the assertion gap is plainly visible in the .t.sol).
- CWE-1288 (improper validation of consistency) / drift-detection weakness.
- Fix: make `WitnessHash.t.sol` `assertEq(routeHash, hex"01441b…")` / `assertEq(witnessHash, hex"680557…")` against the same literals the TS test pins, so a Solidity field-order change fails the Foundry suite directly (bidirectional pin, mirroring the keystone content-hash test).
- PoC test idea (already structurally present on the TS side; the gap is on the Solidity side): no new vitest needed — the existing `l1.test.ts` *is* the TS guard. The missing half is a Foundry `assertEq`.
