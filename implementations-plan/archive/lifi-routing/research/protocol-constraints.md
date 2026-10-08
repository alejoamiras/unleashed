# Research: what our own contracts and claim paths impose

Round-1 findings from reading this repository. File references are repo-relative. Confidence **H** unless marked.

## L1 contracts (contracts/bridge/evm/src)

- **Portal clones accept any caller.** `TokenPortalImpl.depositToAztecPublic/Private` use `msg.sender` only as the `safeTransferFrom` source (`_pullExact`); guards: factory `depositsPaused()`, `amount ≤ uint128.max`, exact-in balance delta (fee-on-transfer refused), transient `nonReentrant`. Events `DepositToAztecPublic(to, amount, secretHash, key, index)` / `DepositToAztecPrivate(amount, secretHash, key, index)` — **nothing indexed**; filter by emitter (the CREATE2-derived clone) and match `secretHash` client-side. The Inbox message's L1 sender is the clone.
- **`PortalFactory.createPortal(token)` is permissionless and idempotent**; front-running yields the byte-identical clone/registration; reverts for no code / no `decimals()`; sends the `register` message (fixed public secret hash). Live `createPortal` bounded < 450k gas (`test/FactoryFork.t.sol`); one live call ran out at 306,974 gas while its twin used 345,130 (follow-ups.md, `ensurePortal`). `predictPortal` is a view over immutables — computable off-chain.
- **`SwapBridgeRouter` cannot be driven by an executor.** Both entrypoints pull through Permit2 `permitWitnessTransferFrom` with `owner = msg.sender`; the 12-field `BridgeWitness` (incl. `swapTarget`, `routeHash`, `minFuelOutput`) is "the security boundary" (archive plan `bridge-permit2-recipient-commitment`). Defensive checks worth keeping in any successor: `InexactPull`, FJ balance-delta ≥ reported output, "fuel not consumed" exact input consumption, `forceApprove` to zero, router holds zero between calls, owner-only `sweep` of donated residue, `setSwapTarget` `nonReentrant`.
- **The canonical FeeJuicePortal** `depositToAztecPublic(to, amount, secretHash)` pulls `UNDERLYING` from `msg.sender`, public-only; private gas = public deposit to the PrivateFPC address with a claimer-bound secret (`private-fuel.ts`). Mainnet underlying = AZTEC.
- Gas data (mocked Inbox/Permit2, understates live): `test_gas_bridge_firstTime` 655,910, `test_gas_bridge_known` 240,769 (`.gas-snapshot`). No measured gas for a V4 swap leg or a direct clone deposit.
- The archive plan `bridge-permit2-recipient-commitment` deliberately deleted the app's direct approve + portal path in favour of Permit2-only (an app decision, user-locked at the time); an executor-driven adapter re-opens a non-Permit2 entry. Rationale for Permit2: bind every parameter a relayer could alter.

## L2 (contracts/bridge/aztec) — no change needed (H)

- Content hashes: public `mint_to_public(bytes32 to, uint256 amount)`, private `mint_to_private(uint256 amount)`; no depositor field. Claims consume with `portal_of[token]` as sender; nothing reads the L1 depositor.
- Claim inputs: public `(token, to, amount, secret, leaf)`; private `(token, recipient, amount, claim_salt, leaf)`. **`amount` must equal the deposited amount exactly**; leaf known only after the L1 tx.
- Private claim secret = `poseidon2([claim_salt, recipient], DOM_SEP)` — no chain-id or L1 binding; salt must be full-entropy random (the secret hash and amount are public on L1).
- First claim of a new token consumes the factory's register leaf; `createPortal` + deposit in one Ethereum tx works (register leaf precedes deposit leaf; no L2 ordering constraint beyond `portal_of` being set before the claim).
- Inbox rejects a `secretHash` ≥ BN254 modulus (`Inbox__SecretHashTooLarge`).
- Claims are never pausable; deposits are (factory bit).
- A zero-Fee-Juice user cannot pay any claim; today the fuel leg (FeeJuicePortal deposit + PrivateFPC `mint_and_pay_fee` / `FeeJuicePaymentMethodWithClaim`) solves it. "Nothing is ever sponsored" is repo policy (packages/bridge-core/README.md).

## Decoys and griefing (H on mechanism)

- The `secretHash` is public in the source-chain calldata before the Ethereum deposit lands. Anyone can deposit dust into the same portal with that hash, creating decoy leaves. All are claimable only by the holder of the salt/secret; but `deposit-reconcile.ts` returns `"ambiguous"` on two matches today. Leaf discovery must return a candidate set (filter `amount ≥ expectedMin`) and authenticate by recomputing the message hash (`message-nullifier.ts` `recomputeTokenMessageHash`).
- With an adapter that deposits "whatever arrived" (balance-based), a griefer who sends dust to the adapter/executor mid-flight cannot steal (they donate) — but an adapter that sweeps its *own* balance must never hold idle funds between calls.

## The seal (H)

`personal_sign` of `recoveryKeyMessage` (`packages/bridge-core/src/recovery-crypto.ts`) — text embedding `chain=<l1ChainId> portal bridge record=<secretHash>`; the signature derives an AES key (`EncryptionKey.fromPassword`) sealing `{secret, recipient, amount, sealerL1, salt?}`. The wallet's active chain is not in the signed bytes, so the same EOA on Base produces the identical seal as long as the app passes the Ethereum chain id. The sign-twice determinism self-test is chain-agnostic; trust cache keyed `chainId:address` with the manifest's L1 chain. **The sealed envelope includes `amount`** and `envelopeMatchesRecord` compares it — a variable delivered amount needs an envelope/record update after the fill.

## Mainnet readiness (H)

`apps/tools/public/mainnet-bridge.json`: `bridge: null`; FeeJuicePortal, AZTEC, PrivateFPC 5.0.1 pinned; mainnet runs an older Aztec line than testnet (6.0.0-rc.1). No mainnet factory/router/hub. A mainnet generation follows `.claude/skills/bridge-generation/SKILL.md` with owner authorization at each live step; `/harden security` is a recorded prerequisite.
