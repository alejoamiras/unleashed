---
plan: protocol-labels
tier: light
status: closed
---

## Outcome

Closed. The labels in the tree run on the live testnet; this record is history, not a task list.

- **The generation.** Factory `0xd97823e0009c12ff5771a40ece505622c449152c`, router
  `0xb6d603f425519a5009d7d426f31d92177da7cfab`, swap target
  `0x2247e05babad88a44e837e2ddaf54c6d607860f7`, hub
  `0x1a0a913173a8b010a87b703748767e15a031b6c01a314e9b905de3df85fcb715`. USDC, USDT, EURC and GBPC
  each have a portal, and all four are registered on the hub. Promoted with `--bridge-only`; the
  faucet record was already current.
- **Calibration.** `fjPerTx` 3.28 FJ and `fjRegister` 2.94 FJ. The private first claim ran for the
  first time on this network, with a 14.88 FJ ceiling. `minFuelFj` stays at 29.77 FJ until a full
  calibration sizes it.
- **Canaries.** All green against the promoted manifest; 0.0199 of the 2.0 ETH cap spent
  ([`lessons/phase-3.md`](lessons/phase-3.md)).
- **The retired generation.** Its guardian pauses its factory's token-portal deposits when the app
  switches to this manifest.
- **Opened** ([`follow-ups.md`](../../follow-ups.md)): `ensurePortal` reads its receipt without
  checking the status; the `minFuelFj` floor's full calibration.

# protocol-labels

Finalise the bridge's protocol labels ahead of mainnet, and deploy the testnet generation that
follows from it.

## Summary

Some strings in this repository are protocol. The claim-secret separator label feeds every private
claim secret. The keystone vectors pin that derivation across TypeScript, Noir and Solidity. The
journal key, the lock and cache names, the backup format id and the recovery message decide which
records a browser can find and which backup files it accepts. The deployer derivation label decides
which L2 account deploys a generation. Once a mainnet generation exists, none of them can change
without stranding funds or records, so they were settled in one pass, before that point.

The hub embeds the claim-secret library, so its class id moved with the separator label. A deployed
hub cannot be re-pinned to a new class. Under the `bridge-generation` runbook this is **a new
generation on an unchanged network**: the network identity, the FeeJuicePortal and the signer stay;
the factory, router, swap target, hub and every bridged token are new.

Two open follow-ups close with this generation:

- **Comments in deployed contract sources.** Solidity's metadata hash covers comments, so wording a
  deployed source differently changes its bytecode. `TestUsdc.sol`, `mocks/MockSwapTarget.sol` and
  `interfaces/ITokenPortal.sol` now describe what each contract does. The interface is compiled
  into the router, which this generation redeploys; the other two have no deployment on the
  current network.
- **The private first claim.** `register_token` plus a claim, both paid through the PrivateFPC, had
  not run on the 6.0.0-rc.1 network. A new hub starts with every token unregistered, which is the
  chance to measure it.

## Owner decisions

| Question | Answer |
|---|---|
| Deploy now, or wait for the next network reset | Now. A reset is a generation of its own. |
| Live authorization | The full scripted redeploy: L1 broadcasts, L2 deploys and promotion under `live-intent`, through keyed runs. No credential is created. |
| Token set | USDC, USDT, EURC and GBPC, the set the testnet already bridges. |
| Spend cap | 2.0 ETH, the value of `CAPS.maxTotalEthSpend`. |
| Visible wording | The recovery-key signing prompt, the recovery-file refusal and the backup's download name, as they stand in the tree. |
| Mainnet deployer | Its derivation prefix is an input with no default, held in 1Password and chosen at the first mainnet deploy: a forgotten setting throws instead of selecting another account. |
| The retired generation | Its guardian pauses its factory's token-portal deposits just before the app switches to the new manifest, so a page still open on the old one cannot start a token deposit the app will never show. Withdrawals stay open. Gas-only sends do not pass through the factory and stay possible from such a page until it reloads. |
| Migration | None. Testnet records made on the retired generation are not shown: the journal key changed with the labels, and the journal already withholds records bound to another generation. Mainnet has no generation yet. |

## Outcome & Quality Bar

**For whom.** The owner operating the testnet bridge; a tester who bridges on testnet; the
maintainer who deploys the first mainnet generation.

**Excellent looks like:**

1. **One derivation, three toolchains.** The separator literal, the claim secrets, the secret hashes,
   the register content hash and the hub-derived token address agree between TypeScript, the Noir
   keystone and the Solidity keystone. Each value is produced by the production function in one
   toolchain and asserted unchanged by the others.
2. **The live testnet runs the labels in the tree.** Every canary passes against the promoted
   manifest, not the candidate.
3. **The first mainnet generation needs no protocol-label decision.** Every label it depends on is
   the one the tree already holds. Its only input is the deployer prefix, chosen at that deploy.

**Good enough.** No UI explains the withheld testnet records.

**Visible to a user.** No layout changes. Three strings carry the settled labels: the recovery-key
signing prompt, the refusal of a file that is not a bridge recovery file, and the backup's download
name. The theme choice is stored under a key settled in the same pass, so a returning browser starts
on "System" once.

## Architecture & Implementation

### What changed in the tree

- `contracts/bridge/aztec/claim_secret`: the separator label and its pinned literal. The literal is
  `poseidon2HashBytes(label) & 0xffff_ffff`, and it differs from the FPC fuel separator and from
  the protocol's secret-hash separator.
- `contracts/bridge/aztec/keystone`, `token_bridge_hub/src/test/keystone.nr`,
  `contracts/bridge/evm/test/Keystone.t.sol` and the TypeScript tests beside
  `packages/bridge-core/src/claim-secret.ts`: the vectors.
- `contracts/bridge/aztec/token_bridge_hub/target/`: rebuilt. The class id pin lives in
  `packages/bridge-core/src/noir-artifact-classids.test.ts`.
- `packages/bridge-core/src/{journal,backup,recovery-crypto,seal-trust,token-list}.ts`: storage keys,
  the backup format id and the recovery message. The recovery message is pinned byte for byte by a
  test, because it is signed.
- `packages/bridge-core/scripts/deployer-keys.ts`: the derivation prefix is an input.
- `packages/bridge-core/scripts/verify-l1.ts`: `--strict` also compares the swap target's runtime
  code and reads back its three constructor immutables.
- `packages/bridge-core/scripts/live-intent.ts`: an intent with no build commit can never authorise
  a run.
- `packages/bridge-core/scripts/pause-factory.ts`: the guardian's deposit pause on a generation's
  factory, testnet only.

### A new generation on an unchanged network

The runbook's reset branch assumes the network moved. Here it did not, which changes four things:

- **The reset baseline stays where it is.** `live-intent build` compares the node's identity with
  the committed baseline and passes, because nothing moved.
- **The completed generation's deploy journal is removed first.** Its identity stamp is unchanged,
  so the conductor would otherwise resume it and stop at the journalled hub class id.
- **Pools already exist.** `--seed-pool` on an existing pool adds liquidity instead of refusing, so
  the deploy runs with `SKIP_POOL_SEED=1` and no pre-create passes `--seed-pool`.
- **The live manifest is retired by hand** in a commit of its own, after the candidate exists and
  immediately before `promote`, because promotion refuses a factory or hub move against a live
  manifest. Between those two commits the unit suite and the testnet build are red by construction.

### Order of the live arc

1. Funding check on the pinned signer; `rollupVersion` re-probed.
2. `live-intent.ts build`, with keyless node endpoints, into `lessons/intent.json`. Commit.
3. `forge build --force`; `deploy:generation deploy --dry-run`, then the live run, with two seed
   tokens. `verify:l1 --strict` against the candidate before anything spends through it.
4. `pre-create --no-register` for the third and the fourth token.
5. The candidate smokes. Then two first claims:
   - the third token through `fuel-testnet.ts`, whose claim lands as `register_and_claim_public`;
   - the fourth through `PUBLIC_RUNS=0 PRIVATE_RUNS=1 fuel-testnet.ts`, the private first claim.
     Without `PUBLIC_RUNS=0` the public lane registers the token first and the private lane
     degrades to a plain claim.
6. `calibrate`, with samples kept outside the repository.
7. `live-intent.ts verify --candidate`; retire the live manifest; `promote --bridge-only`.
8. The live canaries against the promoted manifest, `live-intent verify` before each broadcast
   group, and a final `verify` with the spend reconciled against the cap.

Every signing command is a keyed run. Every tracked change is committed before the next one: a keyed
run refuses a dirty tree. From `build` to the final `verify`, nothing outside the operational
allowlist changes.

## Security & Adversarial Considerations

- **A label is a commitment.** A separator shared with another protocol would let a secret meant for
  one be replayed in the other. The Noir keystone and the TypeScript test assert the literal
  differs from the FPC fuel separator; the TypeScript test also holds it apart from the protocol's
  secret-hash separator.
- **No old digest meets a new preimage.** Earlier plans and audits quote the digests of their day.
  They stay as written, and nothing here recomputes or restates them under the new labels.
- **The swap target holds user tokens in flight.** A target bound to another pool manager or paying
  out another asset is a different contract however familiar its code looks, so the promotion gate
  reads its immutables and compares its runtime code.
- **An archived record is evidence, never an authorisation.** A record without its build commit is
  refused by `verify` and `promote`.
- **No credential in a public record.** `build` writes its node endpoints into the intent verbatim,
  so it runs with keyless endpoints, and both fields are read before the intent is committed.
  Forge's broadcast cache, which holds the keyed RPC URL, is deleted after every broadcast attempt.
- **The mainnet deployer cannot be selected by accident.** Its prefix has no default.
- **Two generations from one signer on one network** are visible on any explorer. This plan is the
  reason on record.

## Phases

### Phase 1: Labels, vectors and tooling

The changes of "What changed in the tree".

**Validation gate**
- Commands: `bun run lint`, `bun run typecheck:all`, `bun run test:all`, `bun run test:ci-gating`;
  `bash contracts/bridge/aztec/scripts/compile.sh --check token_bridge_hub`,
  `bash contracts/bridge/aztec/scripts/run-txe-tests.sh --crate token_bridge_hub`, the keystone
  crate's tests, `bash contracts/bridge/aztec/scripts/check-sole-consumer.sh`;
  `bun run --cwd packages/bridge-core deploy:sandbox --smoke`,
  `bun run --cwd packages/bridge-core test:integration`, `bun run e2e:tools`; the contracts workflow
  in CI.
- Pass criteria: all exit 0, with one expected failure until promotion: `verify:deployments` against
  the live testnet manifest reports hub drift, and only that.
- Layers: typecheck/lint, unit, integration, e2e (sandbox).

### Phase 2: The generation

"Order of the live arc", steps 1 to 7.

**Validation gate**
- Commands: `live-intent.ts verify <intent> --candidate …`, then `promote` writes its receipt.
- Pass criteria: the receipt is committed, `testnet-bridge.json` equals the promoted candidate, and
  the Phase 1 commands pass with no expected failure.
- Layers: live testnet.

### Phase 3: Canaries and close

Step 8, then the two follow-ups are closed in `follow-ups.md` and `minFuelFj` is revisited against
the measured private first claim.

**Validation gate**
- Commands: `verify:l1 --strict`; `verify:deployments`; `check-fpc-version.ts --mode
  require-deployed`; the fuel, fee-juice and drip canaries; the final `live-intent.ts verify`.
- Pass criteria: all exit 0; each canary's success line is quoted in `lessons/`; the spend
  reconciles with the cap.
- Layers: every layer, and the live testnet.
