# Updating the Aztec line and Noir

What a bump of the Aztec line touches in this repository. From 6.0 the line publishes as
`@aztec-labs/*` and `@aztec-foundation/*`, and nothing resolves under the old `@aztec/*` scope; it is
exact-pinned and bumped by hand. A bump installs fresh publishes, so it clears the 7-day release-age gate only through the
temporary excludes in § The pin surface, removed in the same PR ([`AGENTS.md`](AGENTS.md)
§ Dependency policy). Whether
the bump is also a new bridge generation, and how to deploy one, is the
[`bridge-generation`](.claude/skills/bridge-generation/SKILL.md) skill: classify the bump there first.

> **Convention:** code that types against an `@aztec` shape (an artifact field, a node RPC result, a
> wallet-sdk capability) adds an entry to § Couplings below, with its file, so the next bump has a
> checklist.

Current line: **`6.0.0`**. Labs and foundation number their releases separately, and the standards
package keeps a pin of its own:

- **`@aztec-labs/*` at `6.0.0`**, the `@aztec-labs/aztec.js` pin. The rest of the line follows
  this number: `@alejoamiras/private-fee-juice`, the Noir contract source (the aztec-nr tags in
  every `Nargo.toml`, `contracts/bridge/aztec/scripts/compile.sh`, the committed `target/*.json`)
  and the toolchain at `~/.aztec/versions/6.0.0`. The Nulo wallet's packages sit at `0.3.0`,
  whose Aztec peers are exact labs `6.0.0` pins.
- **`@aztec-foundation/*` at `6.0.0`** (`bb.js`, `l1-artifacts`, `noir-acvm_js`,
  `noir-noirc_abi`): the version the locked `@aztec-labs/aztec.js` requires. Foundation numbers its
  releases on its own: its release candidates ran ahead of labs' (rc.6 beside labs' rc.3), and the
  two numbers met again at `6.0.0`.
- **`@aztec-foundation/aztec-standards` at `6.0.0`**, its own pin. It follows the tags of
  `AztecProtocol/aztec-standards`, which the hub's Noir `token` dep names too.

[`scripts/ci-cd/aztec-line.test.ts`](scripts/ci-cd/aztec-line.test.ts) holds each scope to its own
version, and writes none: labs at the aztec.js pin, foundation at the version labs' lock entry
requires for `@aztec-foundation/l1-artifacts`, `aztec-standards` at its declared pin, and every
root `patchedDependencies` key at the foundation version, and every Aztec declaration in every manifest at
exactly its scope's version. It also fails on any resolved `@aztec/*` package, in the root
lockfile and in the TXE server's: from 6.0.0 the line depends on stock `viem`, and the
`@aztec/viem` fork has left the tree. The hub's class ids depend
on these inputs, so they move only with a new generation.

## Before you bump

1. The Nulo wallet's repository publishes `@nulo-sh/wallet-crypto`,
   `@nulo-sh/resolve-asset` and `@nulo-sh/wallet-sdk-schema-patch` on the new line
   first. [`scripts/ci-cd/published-packages.test.ts`](scripts/ci-cd/published-packages.test.ts) holds each
   peer to this repository's pin, so the bump waits for those versions.
2. Read the upstream `@aztec-labs/aztec.js` changelog for the target version, then scan
   `gh api repos/aztec-labs-eng/aztec-node/compare/v<old>...v<new>` for `!:` commits and grep this
   repository for the symbols they break. aztec-nr lives in `aztec-labs-eng/aztec-nr`, the standards
   in `AztecProtocol/aztec-standards`.

## The pin surface

- `@aztec-labs/*` and `@aztec-foundation/*` exact pins in `apps/tools/package.json`,
  `packages/bridge-core/package.json`, `packages/sdk/package.json` and
  `contracts/bridge/aztec/txe-server/package.json`, each scope at its own version (above). The SDK's
  published peers follow its pins; its consumer fixture (`packages/sdk/test/consumer/package.json`)
  declares the same pins and is relocked with `bun scripts/pack-check.ts --relock` from `packages/sdk`
  (a relock re-checks the release-age gate, so it takes the same temporary excludes). `packages/bridge-core` pins stock `viem` at exactly the version the
  line depends on (`2.57.1` on 6.0.0), so `flows.ts`'s `OutboxContract` client shares the Aztec
  packages' copy; move it with the line.
- The three packages the Nulo wallet's repository publishes, at the versions published for the new line.
- The Noir wasm patches: `patches/@aztec-foundation%2Fnoir-{acvm_js,noirc_abi}@<v>.patch` and the
  `patchedDependencies` keys in the root `package.json`. The file names and the keys name the
  foundation version, not the labs one. A bump regenerates them, or they silently stop applying;
  `aztec-line.test.ts` fails on a key off the foundation version.
- `bunfig.toml` `minimumReleaseAgeExcludes`: fresh publishes are blocked by the release-age gate,
  transitives included. Add every new-line name from `bun.lock` while `bun install` resolves the new
  line, then delete them again in the same PR (the standing exemptions stay) and prove the
  lockfile with `bun install --frozen-lockfile --force`. For the following 7 days a `package.json`
  edit in a workspace that reaches the new line re-gates it: land the bump's dependency changes in
  the bump PR, and re-add the excludes locally, uncommitted, for a stray later edit.
- `bun install` after editing the pins: targeted re-resolution is the default, and deleting
  `bun.lock` is a last resort (a full regeneration re-gates every locked version). Old-line entries
  left in `bun.lock` are a missed pin; `aztec-line.test.ts` names them.
- CI resolves two toolchains separately: `.github/actions/setup-aztec` installs the toolchain at the
  `@aztec-labs/aztec.js` pin read from `apps/tools/package.json`, and `_bridge-contracts.yml`
  installs the Noir toolchain from the crates' `Nargo.toml` tag. Moving the JS line never touches the
  Noir pin, and the other way round.
- The Noir surface (compile script, the one-tag rule, the hub's `token` dep, `target/*.json`, the
  TXE server's lockfile) is in the skill's Phase 1.

## Couplings

- **Noir wasm dedupe**: `apps/tools/vite.config.ts` `dedupe` lists `@aztec-foundation/noir-noirc_abi`
  and `@aztec-foundation/noir-acvm_js`; without it `initAbi()` and `abiEncode()` land in different module scopes
  and the wasm instance never resolves. Re-check it when the packages' entry layout changes.
- **Hub ↔ factory, a circular binding deployed as one unit.** The hub's address is salted with the
  factory's (`salt = Fr(factory)`, `deriveManifestHub` in `packages/sdk/src/protocol/manifest-v2.ts`)
  and the factory's constructor takes the hub; the router binds the factory and the `FeeJuicePortal`
  as immutables. `scripts/generation.ts` predicts the factory from the deployer's pending nonce and
  refuses to broadcast if it moved. A reset or any class-id shift below means a whole new generation.
- **`tokenClassId` ↔ the standards `Token` artifact.** The hub's `token_class_id` is computed from
  the installed `@aztec-foundation/aztec-standards` artifact; every L2 token derives from it
  (`src/hub-token.ts`, class id pinned by `noir-artifact-classids.test.ts`, address vector by
  `hub-token.test.ts`). A standards bump that moves the class id cannot be absorbed by a deployed hub.
- **Hub → the protocol's `ContractInstanceRegistry`.** `register_*` calls aztec-nr's
  `publish_contract_instance_for_public_execution` (the `Nargo.toml` tag), which the running network
  must still route. The TXE cannot exercise it; the sandbox smoke's first-time flows are the
  only pre-live canary.
- **Two toolchain readers, one version.** `packages/bridge-core/scripts/sandbox/local-network.ts`
  boots `aztec start --local-network` from `~/.aztec/versions/<@aztec-labs/aztec.js pin>` (read from
  `packages/bridge-core/package.json`; it refuses a partial toolchain), while `compile.sh`,
  `nargo.sh` and `run-txe-tests.sh` default `AZTEC_HOME` to a literal version. Move both together.
  Both name the labs version, never the foundation one: on this line, `~/.aztec/versions/6.0.0`
  (`aztec-up install 6.0.0`).
- **Canonical PrivateFPC**: the address and the digest are pinned in
  `packages/sdk/src/protocol/private-fuel.ts` (`PRIVATE_FPC_ADDRESS`, `PRIVATE_FPC_SALT = 0x…01`) and
  `private-fpc-canonical.json` (`expectedAddress`, the artifact sha256, the human-curated
  `compatibleNodeVersions` keyed by digest, the network identity pins). `private-fuel.test.ts`
  re-derives the address from the installed artifact at that salt with deployer zero, and holds
  `PRIVATE_FPC_ADDRESS` and the salt equal to the installed package's `canonical-deployment.json`.
  A new artifact digest needs a fresh compatibility entry (it fails closed), and every rebuild site
  uses `PRIVATE_FPC_SALT`. The Nulo wallet pins the same address.
  - **Nothing deploys the testnet FPC.** The artifact has no initializer and no public function of
    its own. The app and the wallet register the instance locally, and the node reads the fee
    payer's balance by storage slot. Anyone may publish the instance, so the gate accepts either
    state.
  - **The gate has one behaviour.** `scripts/check-fpc-version.ts` checks the node version against
    the digest's compatibility entry, the identity pins, the artifact digest and the descriptor's
    coherence with the constants. At the pinned address, absence is green, and a published instance
    must carry the expected original and current class. An RPC failure is an error, never absence.
  - **The line table** (`packages/sdk/src/protocol/aztec-line.ts`) keys each L1 chain to its line's
    descriptor: mainnet to `private-fpc-canonical-mainnet.json` (its own identity pins), every other
    chain to the installed one. A line is supported only while its descriptor's `aztecVersion` is the
    installed one; every send on another line is refused before signing, and a manifest's
    `privateFpc` must name its line's FPC and digest. A bump moves both descriptors together when
    mainnet's canonical rollup runs the new line, and only testnet's while mainnet's still runs the
    old one, which then refuses until its own bump. `PRIVATE_FPC_ADDRESS` stays the installed line's.
    Mainnet's FPC scripts (`deploy-private-fpc-mainnet.ts`, `deploy-canonical-private-fpc.ts`,
    `fpc-dust-canary-mainnet.ts`) keep their own presence checks.
- **Fee Juice contract**: bound through `FeeJuiceContract.withWallet` from
  `@aztec-labs/aztec.js/protocol`. The scripts take it from `packages/bridge-core/scripts/fee-juice-l2.ts`,
  which asserts the bound address equals the node's `protocolContractAddresses.feeJuice`, so a wrong
  endpoint or a split line aborts before anything is sent.
- **Testnet node ↔ CSP**: the browser's node is dRPC's keyless public endpoint,
  `https://aztec-testnet.drpc.org`: the testnet `nodeUrl` in `apps/tools/src/lib/network-targets.ts`
  and the only node entry in its `cspConnectSrc` (`network-targets.test.ts` pins both). It holds no
  key. A new endpoint must answer without a redirect to another host, which the CSP blocks, and must
  admit the app's Origins in its CORS preflight. Scripts never use it: they compose
  `https://lb.drpc.live/aztec-<network>/<key>` from `DRPC_API_KEY`, the owner's shared dRPC CLI key
  (`requireDrpcNodeUrl`, `packages/bridge-core/src/drpc-node.ts`), which reaches a run only from a
  keyed-run template. The FPC gate and `live-intent verify` read the keyed node, so the PrivateFPC
  descriptor's compatibility entry records its `nodeVersion`, not the keyless endpoint's.
- **Fee Juice claim phases**: `FeeJuice.claim_and_end_setup` is valid only as the fee payload; an
  app-phase claim under a sponsored fee uses plain `claim` (`apps/tools/src/composables/fuelClaim.ts`,
  `deposit-flow.ts`).
- **Token `constructor_with_minter` arity**: five parameters since 5.0.1, the last `auth_contract`.
  `apps/tools/scripts/deploy.ts` records `constructorArgs.authContract`, and
  `apps/tools/src/contracts/deployments.ts` (`rebuildTokenInstanceFrom`) requires it. An arity change
  breaks derivation everywhere at once; `verify:deployments` is the detector.
- **Mainnet Drip deploy ↔ the canonical portal and the account artifact**: the self-funded deploy
  (`packages/bridge-core/scripts/drip-deploy.ts`, `deployer-funding.ts`) scans the portal's deposits from
  `PORTAL_FIRST_BLOCKS` and refuses a portal without an entry, so a canonical-rollup switch adds the new portal's
  first block. `ACCOUNT_CLAIM_DEPLOY_GAS` (`fee-juice-l2.ts`) was measured for the 6.0.0 Schnorr account; a bump that
  changes the account contract or the claim re-measures it on the sandbox
  (`deployer-funding.integration.test.ts` fails when the limit is too low).
- **Cross-chain discovery ↔ the Inbox**: `packages/bridge-core/src/crosschain-discovery.ts` decodes the Inbox's
  `MessageSent` (the line's `InboxAbi` shape, or the older checkpoint shape the caller names) and recomputes each
  router deposit's leaf from the record. A bump that changes the event or the message hash leaves every deposit
  unauthenticated; rerun the discovery tests and the testnet canary.
- **Deploy-intent tooling**: `packages/bridge-core/scripts/live-intent.ts` (plan-pinned signer,
  caps, candidate digest, privileged readbacks, tree gate) and `manifest-v2.ts` (a strict zod
  manifest, re-derived on parse), with the testnet canaries. A reset re-runs the whole arc under them.
- **Token-list URL ↔ digest ↔ CSP**: `TOKEN_LIST_URL` (`packages/bridge-core/src/token-list.ts`) is
  one exact-version file of `@uniswap/default-token-list` on jsDelivr, `TOKEN_LIST_SHA256` is that
  file's digest, and `TOKEN_LIST_SOURCE` (`apps/tools/src/lib/network-targets.ts`) repeats the URL
  as the only list entry in each target's `cspConnectSrc`. Bump all three together, to a version at
  least 7 days old (`npm view @uniswap/default-token-list time`). Take the digest from npm's tarball
  after checking it against the registry's `dist.integrity`, never from the CDN alone. Then update
  the Sepolia pair `token-list.test.ts` expects and run it with `TOKEN_LIST_LIVE=1`.
  `network-targets.test.ts` fails when the URL and the CSP differ; a stale digest or CSP silently
  degrades the catalog to the manifest's tokens.
- **Per-token wallet grants**: `buildSendManifest` (`apps/tools/src/lib/capabilities.ts`) carries the
  hub and the whole set of granted tokens (exact L2 addresses, `burn_public` and `burn_private` for
  the exit authwit); a new token re-prompts and the approval replaces the stored grant.
  `useTokenGrant` checks the returned scope against the request before anything is signed, so a
  wallet-sdk capability reshape fails there, not at send time.

## After you bump

- `bun run typecheck:all` and `bun run test:all`, each judged by its exit code, then
  `bun run audit:tools`.
- The four drift detectors in the skill's Phase 1; on a reset, Branch B.
- `bun run e2e:tools`, and the contract suites (`bridge-contracts.yml` runs them on the PR).
- Clear `apps/tools/node_modules/.vite` before the first dev-served run on the new line.
