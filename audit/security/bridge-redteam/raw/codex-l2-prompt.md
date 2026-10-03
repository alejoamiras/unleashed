# Codex red-team: Unleashed bridge — L2 Noir + cross-chain + JS

You are a smart-contract security auditor red-teaming the L2 (Aztec/Noir) side of an L1↔L2 token bridge plus the cross-chain content-hash boundary and a light pass on the JS that builds the L1 signing payload. Goal: find how an attacker can **mint free L2 tokens, claim someone else's bridged funds, strand funds via an L1↔L2 content-hash mismatch, bypass the minter allowlist or pause, or exploit the deposit→claim window.** Adversarial mindset.

## Read first (in the repo)
- `audit/security/bridge-redteam/context.md` — threat model + 10 hot-spots (attack/confirm/kill each).
- `audit/security/bridge-redteam/raw/repo-map.md` — L1↔L2 flow + trust boundaries.

## Audit these files
- `packages/bridge-aztec/token_bridge/src/main.nr` + `config.nr` (claim_public/private, exit_to_l1_*, pause, 2-step ownership)
- `packages/bridge-aztec/token_minter_proxy/src/main.nr` (minter allowlist, mint/burn, set_token/set_minter)
- `packages/bridge-aztec/keystone/src/main.nr` (cross-toolchain content-hash equality vectors)
- **Cross-chain match**: compare the L2 `get_mint_to_public/private/withdraw_content_hash` (token_portal_content_hash_lib) against the L1 `TokenPortal.sol` selectors `mint_to_public(bytes32,uint256)`, `mint_to_private(uint256)`, `withdraw(address,uint256,address)`. Any selector/arg-order/encoding drift strands funds. Is the keystone test wired into CI (search workflows)?
- **Wiring**: `packages/bridge-core/scripts/deposit-testnet.ts`, `packages/bridge-aztec/scripts/*` — does deploy authorize ONLY the bridge as minter? proxy.set_token once?
- **JS (light)**: `packages/faucet/src/composables/useDeposit.ts`, `packages/bridge-core/src/flows.ts`, `private-fuel.ts` — does the witness built in JS match the Solidity `BRIDGE_WITNESS_TYPEHASH` field order exactly? Is the bearer `secret` generated from a CSPRNG (unpredictable)? Is `minFuelOutput`/slippage a sane floor? Right `aztecRecipient`?

## Taxonomy
Access control / authorization (Noir public vs private, `#[only_self]`, msg_sender), minter-allowlist bypass, pause TOCTOU (enqueue_self pattern), bearer-secret exposure (private claim omits recipient — where can the secret leak: events, calldata, logs, frontend storage? is the deposit→claim window front-runnable so an observer claims first?), content-hash mismatch (strand) / forgery (free mint), replay / reorg of L1→L2 messages, double-claim, amount=0 / overflow (u128), ownership-transfer abuse, JS↔Solidity witness drift, weak randomness for secrets, recipient/route mis-binding in JS.

## For EACH finding return (structured):
1. Title. 2. Impact factors + exploitability (no CVSS number). 3. Confidence. 4. CWE/SWC or "Noir/Aztec-specific: <desc>". 5. Trace `file:line` source→sink (name both chains where cross-chain). 6. Exploit/strand scenario, concrete. 7. Preconditions. 8. Why existing guards fail (or, if a hot-spot is actually safe, say so + why). 9. Fix. 10. PoC test idea (Noir `#[test]`/TXE for L2; vitest for JS; note if it needs the sandbox).

No concrete trace ⇒ NON-FINDING. Be critical; break each hot-spot before validating. Note explicitly whether the bearer-secret design (recipient-commitment deferred) introduces an EXPLOITABLE path vs an accepted-risk. Respond as markdown, tight findings.
