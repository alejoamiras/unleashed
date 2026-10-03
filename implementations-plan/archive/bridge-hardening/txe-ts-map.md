# TXE ↔ TS behavior-mirroring map

Every circuit behavior proven in the TXE suite (`token_bridge/src/test/`, Arc 9) and where the
TypeScript side re-implements or consumes it. A change to any row's Noir behavior must update
its TS counterpart in the same PR — that symmetry is what makes toolchain drift impossible to
miss.

| Noir behavior (TXE test) | TS counterpart | Pin |
|---|---|---|
| `claim_public` content hash binds (to, amount) | `content-hash.ts` `mintToPublicContentHash` (independent sha256>>8 model) | `content-hash.test.ts` keystone vectors + `keystone` crate vectors |
| `claim_private` consumption secret = derive(salt, recipient) | `deriveTokenClaimSecret` (poseidon2, DOM_SEP 3140354885) | `claim-secret.test.ts` + keystone fuzz (salt/recipient neighbor injectivity) |
| relayer redirect rejected (F-007) | structural: no raw-secret path exists in TS flows; salt always injected at deposit | `flows.test.ts`; sole-consumer guard `check-sole-consumer.sh` |
| pause gates block claims/exits | frontend refuses claims for paused deployments via manifest state (no circuit mirror needed) | — |
| proxy: only-bridge mints, single-shot wiring, owner has no mint power | conductor read-backs assert `get_token`/`get_bridge` post-deploy | `deploy-bridge-mainnet.ts` §6 read-backs |
| exit burns + L1 message content | `withdrawContentHash` model | `content-hash.test.ts` withdraw vector |
| route acceptance rules (`_validateRoute`) | `buildFuelRoute` derivation | `route.test.ts` + `route-conformance.test.ts` oracle |
| Permit2 witness shape (router) | `BRIDGE_WITNESS_TYPEHASH` + typed-data builder | `l1.test.ts` ↔ `WitnessHash.t.sol` literals |

## Not mirrored on purpose

- Nullifier replay / membership proofs: protocol-level, exercised by TXE consume semantics;
  a TS re-implementation would test the mock, not the system.
- Gas/fee calibration constants (`PUBLIC_CLAIM_GAS` etc.): live-network quantities tracked in
  `econ-matrix.md` and canaries, not unit-testable truths.
