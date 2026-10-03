# Phase 4 — `@unleashed/bridge-core` (framework-agnostic L1<->L2 TS)

**Status:** ✅ DONE — all node-layer modules (l1 / l2 / status / recovery / recovery-crypto / content-hash / progress / fee-juice) + 37 unit tests; deposit public/private + withdraw public proven end-to-end on the sandbox.

## Done
- ✅ Package scaffold (`@unleashed/bridge-core`; `tsc --noEmit` + vitest; no runtime deps yet — the pure layer needs none).
- ✅ `progress.ts` — the improved loading-bar model (the reference bridge's weak point: a bar that lies about ETA). Block-based path (L2->L1: proven-vs-needed → genuine "N blocks remaining (~M min)") + time-based fallback (L1->L2: elapsed/maxWait, capped at `PROGRESS_CAP=0.95` so it never reads "done" before the message is consumable). 8 unit tests (block mid/ready/singular/cap/ETA, time proportional/overrun/indeterminate). typecheck + lint green.

- ✅ `recovery.ts` — no-server resume schema: deposit + withdrawal records in two localStorage keys, via an injected `KV` interface (DOM-free → unit-testable). Claim secret held as an opaque `encryptedSecret` blob (R2: bearer credential for private transfers). `upsert`/`update`/`remove`/`find` + corrupt-JSON tolerance + bigint-as-string amounts. 9 unit tests.
- ✅ `recovery-crypto.ts` — seal/open the claim secret reusing `@alejoamiras/nulo-wallet-crypto` PBKDF2+AES-GCM, keyed off a deterministic L1 signature (`recoveryKeyFromSignature` → `EncryptionKey.fromPassword(sig)`: same sig ⇒ same key, re-derivable cross-session/device — the no-server resume guarantee; relies on RFC-6979 deterministic signing). 4 tests (round-trip, re-derivable cross-decrypt, wrong-key rejection, random-IV). **21 bridge-core tests total.** Gotchas: bridge-core's `tsc` needs `@types/node` + `types:["node"]` (wallet-crypto uses `Buffer`); wallet-crypto uses `self.crypto` → a `self=globalThis` test shim (no jsdom needed).

- ✅ `content-hash.ts` — pure-TS L1↔L2 content hashes (the THIRD keystone toolchain). `sha256ToField = uint256(sha256(data)) >> 8` (verified against the keystone vectors → it's "0x00 + first 31 bytes of the digest"); selectors hardcoded as `keccak256(sig)[:4]` (`mint_to_public bc6a9bd3`, `mint_to_private 8b3af5e8`, `withdraw 69328dec`); no aztec.js. 3 tests asserting byte-equality with the SAME fixed vectors as the Solidity (`ContentHash.t.sol`) + Noir (`keystone`) tests → the cross-chain content-hash is now pinned across **all three toolchains**. **24 bridge-core tests.**

**Pure layer is COMPLETE** (progress, recovery, recovery-crypto, content-hash).

## Integration — UNBLOCKED (sandbox live, no wagmi, deps wired)
- ✅ Node-layer deps in bridge-core: `@aztec/aztec.js` + `@aztec/accounts` + `@aztec/foundation` + the viem fork (`npm:@aztec/viem@2.38.2`). **No wagmi** — the faucet is pure aztec.js; the bridge does L1 with viem directly (corrected an earlier wrong assumption).
- ✅ **Sandbox L1 deploy LIVE** (`scripts/deploy-sandbox.ts`): `anvil_setCode` Permit2 (runtime bytecode fetched from Sepolia, since a fresh sandbox lacks it) + deploy MintableERC20 / MockSwapTarget / SwapBridgeRouter, verified against the running sandbox. feeJuice/portal read from `node_getNodeInfo`. See `research/recon-sandbox.md`.

## L2 deploy plan (next — the aztec.js half)
API (from Holonym `bridge-script/index-testnet.ts`):
- Portal: `deployL1Contract(l1Client, TokenPortalAbi, TokenPortalBytecode, [])` (abi/bytecode from `@aztec/l1-artifacts`), then `portal.initialize(registry, l1Token, l2Bridge)`.
- L2 instances: `getContractInstanceFromInstantiationParams(artifact, { salt, deployer, constructorArgs })`.
- **Unleashed vs Holonym**: aztec-standards `Token` (not `@aztec/noir-contracts.js/Token`) + our `token_minter_proxy` as the single minter (so faucet Dripper + bridge mint the SAME asset) + our attestation-stripped `token_bridge(minter_proxy, portal)` (from `bridge-aztec`, not noir-contracts TokenBridge). Add the bridge to the minter-proxy allow-list.
- Fund `MockSwapTarget` with sandbox feeJuice (`0xa513…` is a TestERC20: `mint`/`addMinter`, else `anvil_setStorageAt`).
- Deployer: an aztec.js account funded via the sandbox (`getInitialTestAccounts`).
- Reference closest to bridge-core's node layer: Holonym `bridge-sdk/src/l1.ts`.

**Confirmed constructors/APIs (compiled artifacts + faucet `scripts/deploy.ts`):**
- `token_minter_proxy`: constructor `()` (owner=deployer); `set_token(token)`, `set_minter(minter, allowed)`, `mint_to_public|private(recipient, amount)`. Artifact `token_minter_proxy/target/token_minter_proxy-TokenMinterProxy.json`.
- `token_bridge`: constructor `(token_minter_proxy: AztecAddress, portal: EthAddress)`. Artifact `token_bridge/target/token_bridge_contract-TokenBridge.json`.
- aztec-standards `Token`: deploy with `constructorArtifact: "constructor_with_minter"`, **minter = the proxy** (faucet sets minter=Dripper; the bridge sets minter=proxy and allow-lists BOTH Dripper + bridge via `set_minter`). `Contract.deploy(deployer, TokenContractArtifact, args, "constructor_with_minter")` + `getContractInstanceFromInstantiationParams`.
- **Full aztec.js plumbing to replicate: `packages/faucet/scripts/deploy.ts`.** Exact imports: `createAztecNodeClient` (`@aztec/aztec.js/node`), `Contract`/`getContractInstanceFromInstantiationParams` (`@aztec/aztec.js/contracts`), `Fr` (`@aztec/aztec.js/fields`), `AztecAddress` (`@aztec/aztec.js/addresses`), `Wallet`/`AccountManager` (`@aztec/aztec.js/wallet`), **`EmbeddedWallet` (`@aztec/wallets/embedded`)**, `deriveSigningKey`/`PublicKeys` (`@aztec/stdlib/keys`), `SPONSORED_FPC_SALT` (`@aztec/constants`), `SponsoredFPCContract` (`@aztec/noir-contracts.js/SponsoredFPC`), Token (`@defi-wonderland/aztec-standards/dist/src/artifacts/Token.js`). Plumbing: `EmbeddedWallet.create(nodeUrl,{pxeConfig:{proverEnabled: network!=='local-network'}})` → `createSchnorrAccount(secret,salt,signingKey)` → `ensureAccountDeployed` → `buildSponsoredFeeOptions` → `deployIfMissing(...).send({contractAddressSalt, universalDeploy:true, wait:{waitForStatus: TxStatus.PROPOSED}})`. **Deps bridge-core still needs:** `@aztec/wallets`, `@aztec/stdlib`, `@aztec/constants`, `@aztec/noir-contracts.js`, `@defi-wonderland/aztec-standards`.

## ⚠️ GOTCHA (cost ~5 turns) — `@aztec/aztec.js` has NO bare `.` export
`import { X } from "@aztec/aztec.js"` fails with **`Cannot find module '@aztec/aztec.js'`** — the package exports ONLY subpaths (`/node`, `/contracts`, `/fields`, `/addresses`, `/wallet`, …). The error LOOKS like a missing dep / broken bun workspace link — it is NOT. `bun -e import('@aztec/aztec.js')` also fails (eval lacks package context — misleading). Do NOT chase it with `bun install --force` / `rm -rf node_modules` (all no-ops). **FIX: import the subpath.** The L1 (viem) deploy already runs; only the L2 aztec.js imports must use subpaths. Check a package's `exports` keys (`package.json`) before assuming a link is broken.

## ✅ RESOLVED — full L2 deploy WORKING (rc.2 transpile via node_modules/.bin)
The rc.2 transpile blocker is fixed — **codex found the rc.2 `aztec` CLI + `bb` transpiler under `~/.aztec/versions/4.2.0-aztecnr-rc.2/node_modules/.bin/`** (I'd only checked `bin/`, which has just nargo+forge). `scripts/compile.sh` runs the rc.2 `aztec compile` (nargo + `bb aztec_process` + VKs) on both contracts → deployable `target/*.json`. NO stable-switch (codex: medium-high API-drift risk; the contracts also pin the Wonderland token + rc.2 content-hash lib). Wonderland transpiles rc.2 the same way (`prerelease-1ad0e28` package.json: `"compile": "aztec compile"`).
- **`scripts/deploy-sandbox.ts` now deploys the FULL stack live on the sandbox**: L1 (Permit2 setCode + MintableERC20/MockSwapTarget/SwapBridgeRouter/TokenPortal via viem) + L2 (TokenMinterProxy + aztec-standards Token [minter=proxy] + token_bridge via aztec.js + EmbeddedWallet + sponsored fee) + wiring (`proxy.set_token`/`set_minter`, `portal.initialize(registry, usdc, bridge)`, mock funded with sandbox feeJuice). ✅ FULL sandbox deploy OK.
- **aztec.js 4.2.0 deploy/call API:** NOT `.send().deployed()` / `.send().wait()`. Compute the instance (`getContractInstanceFromInstantiationParams`), `Contract.deploy(...).send({ ...opts, contractAddressSalt, universalDeploy: true, wait: { waitForStatus: TxStatus.PROPOSED } })`, then `Contract.at(instance.address, artifact, wallet)`. Method calls: `.send({ ...opts, wait: { waitForStatus } })` (wait is an OPTION). The rc.2 `target/*.json` are gitignored (`*/target/`) — regenerate via `scripts/compile.sh`.

## ✅ Flows proven end-to-end on the sandbox (`deploy-sandbox.ts --smoke`)
3 of 4 flow groups GREEN (verified balances): **deposit-public** (claim_public → 100 USDC public), **deposit-private** (claim_private → 100 USDC private), **withdraw-public** (40 USDC burned L2 → released L1).
- **Deposit**: L1 `portal.depositToAztecPublic(l2addr, amount, secretHash)` / `depositToAztecPrivate(amount, secretHash)` — `secretHash = await computeSecretHash(secret)` (`@aztec/aztec.js/crypto`); leaf index from `pub.simulateContract(...).result[1]`; poll-and-`claim_public`/`claim_private` on L2 (retry until the L1→L2 message syncs).
- **Withdraw (codex-unblocked the witness API; consult logged):**
  - **Public burn authwit** — the bridge burns via `proxy.burn_public(msg_sender, amount, nonce)` → `token.burn_public`, so the owner must authorize the PROXY. `EmbeddedWallet` has NO `setPublicAuthWit`; use `SetPublicAuthwitContractInteraction.create(wallet, from, { caller: proxy.address, action: token.methods.burn_public(from, amount, nonce) }, true)` from **`@aztec/aztec.js/authorization`**, then `.send(sendOpts)`.
  - `exit_to_l1_public(recipientL1, amount, caller_on_l1=EthAddress.ZERO, nonce)` — unrestricted case (`_withCaller=false`).
  - **send() resolves to `{ receipt, offchainEffects, offchainMessages }`** — `const { receipt } = await ...send(sendOpts)`; `receipt.txHash`.
  - `await waitForProven(node, receipt)` (`@aztec/aztec.js/contracts`) before the L1 consume.
  - Witness: `messageHash = (await node.getTxEffect(txHash)).data.l2ToL1Msgs[0]`; `computeL2ToL1MembershipWitness(node, messageHash, txHash, 0)` (`@aztec/stdlib/messaging`) → `{ epochNumber, leafIndex, siblingPath }`.
  - L1 consume: `portal.withdraw(recipient, amount, false, BigInt(epochNumber), leafIndex, siblingPath.toBufferArray().map(hex))`. (TRAP: `L1TokenPortalManager.withdrawFunds` hardcodes `_withCaller=false` — only for the unrestricted case.)
- Remaining flow: **one-tx swap+fuel** (router `bridgeWithFuel` + Permit2 witness signing + the mock swap).

## ✅ fee-juice.ts — P4 complete
- `publicFeeJuicePayment(sender, claim)` → `FeeJuicePaymentMethodWithClaim` (`@aztec/aztec.js/fee`): claims bridged FJ + pays L2 gas in one tx (`claim_and_end_setup`) — the headline. Works for a claim from a public OR private deposit (consumes the L1→L2 message by leaf index).
- `sponsoredFeePayment(fpc)` → `SponsoredFeePaymentMethod`: gas via the sandbox/testnet sponsored FPC before any FJ is bridged.
- `feeJuiceAddress` = `AztecAddress.fromNumber(FEE_JUICE_ADDRESS)` (`@aztec/constants`); `FeeJuiceClaim` = `Pick<L2AmountClaim, "claimAmount"|"claimSecret"|"messageLeafIndex">` (`@aztec/aztec.js/ethereum`); `feeJuiceClaimArgs` mirrors the wallet's claim payload.
- **Private-fuel PAYMENT deferred**: aztec.js 4.2.0 `PrivateFeePaymentMethod` is `@deprecated` (unsupported on mainnet); the Wonderland private-FPC path needs an FPC deployed + sandbox validation. The bridge still bridges FJ privately (private claim) — only paying gas *from* a private FJ note is deferred.

## ⚠️ TRAP — bun:test can't import aztec.js (bridge-core uses vitest)
`@aztec/foundation`'s `field.js` calls `expect.addEqualityTesters([...])` at module load. bun:test's `expect` has no `addEqualityTesters`, so any `bun test` file that (transitively) imports `Fr`/`AztecAddress` throws `expect.addEqualityTesters is not a function` at IMPORT time. bridge-core's test script is `vitest run` — always `import { … } from "vitest"` in its tests, never `"bun:test"`.

## Config (from recon)
feeJuice `0x762c…` · feeJuicePortal `0xd336…` · registry `0xa0bf…` · feeAssetHandler `0x5602…` (mintAmount 1000 FJ). See `research/recon-testnet.md`. SANDBOX addresses are sandbox-instance-specific (read at runtime via `node_getNodeInfo`).
