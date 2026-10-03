# Holonym L1 Contracts — Research Notes

Research module for the faucet-bridge blueprint.
Covers `l1-contracts/` in the Holonym reference repo only.
Target repo paths are written relative to the repo root.

---

## Purpose

Holonym built a production Aztec bridge that:
1. Accepts tokens from users via Permit2 SignatureTransfer (one signature).
2. Optionally swaps a "fuel" portion to FeeJuice via Uniswap V4 PoolManager.
3. Deposits FeeJuice to Aztec L2 via the canonical `IFeeJuicePortal`.
4. Deposits the remaining token to Aztec L2 via a custom `TokenPortal`.
5. Gate-keeps private deposits behind Holonym identity attestations (Clean Hands / Passport).

The goal is to reuse the swap + bridge core and DROP the identity layer entirely.

---

## Key files

| File | Role |
|---|---|
| `[holonym] l1-contracts/src/SwapBridgeRouter.sol` | Permit2 periphery — atomic swap+bridge entry point |
| `[holonym] l1-contracts/src/TokenPortal.sol` | Aztec inbox/outbox bridge for a single ERC-20 |
| `[holonym] l1-contracts/src/UniswapFuelSwap.sol` | Uniswap V4 flash-accounting swap adapter |
| `[holonym] l1-contracts/src/interfaces/ITokenPortal.sol` | Minimal public-deposit interface |
| `[holonym] l1-contracts/src/interfaces/ISignatureTransfer.sol` | Permit2 interface (stripped) |
| `[holonym] l1-contracts/src/governance/interfaces/IMintableERC20.sol` | Aztec FeeJuice handler interface |
| `[holonym] l1-contracts/script/DeploySwapBridgeRouter.s.sol` | Router deploy |
| `[holonym] l1-contracts/script/DeployTokenPortalWithForwarder.s.sol` | Portal + router deploy + wire |
| `[holonym] l1-contracts/script/DeployUniswapFuelSwap.s.sol` | UniswapFuelSwap + pool bootstrap |
| `[holonym] l1-contracts/script/SeedUniswapPools.s.sol` | Standalone pool seeder |
| `[holonym] l1-contracts/script/SetTrustedForwarderAllPortals.s.sol` | Bulk forwarder update |
| `[holonym] l1-contracts/src/test/SwapBridgeRouter.t.sol` | Router unit tests (mocked) |
| `[holonym] l1-contracts/src/test/TokenPortal.t.sol` | Portal unit tests (mocked Aztec infra) |
| `[holonym] l1-contracts/src/test/UniswapFuelSwap.t.sol` | Swap adapter unit tests |
| `[holonym] l1-contracts/foundry.toml` | Foundry config |

---

## Findings

### 1. SwapBridgeRouter — flows, Permit2 binding, reentrancy, sweep, governance

#### `bridgeWithFuel` flow (full path)

```
user calls bridgeWithFuel(BridgeParams p, PermitParams permit)
  nonReentrant gate
  Validate: totalAmount > 0, 0 < fuelAmount < totalAmount, path.length > 0,
            path.length == zeroForOnes.length, tokenPortal != address(0)
  bridgeAmount = totalAmount - fuelAmount

  1. _pullTokensWithWitness(msg.sender, p.bridgeToken, p.totalAmount, permit, witnessHash)
     → permit2.permitWitnessTransferFrom(...)
       Pulls p.totalAmount of p.bridgeToken from user → this contract

  2. Snapshot: fjBalBefore = feeJuiceToken.balanceOf(address(this))
     token.forceApprove(swapTarget, fuelAmount)
     fuelReceived = swapTarget.swap(bridgeToken, fuelAmount, minFuelOutput, path, zeroForOnes)
     token.forceApprove(swapTarget, 0)
     Verify: fjBalAfter - fjBalBefore >= fuelReceived  ← defense-in-depth

  3. feeJuiceToken.forceApprove(feeJuicePortal, fuelReceived)
     (fuelKey, fuelIndex) = feeJuicePortal.depositToAztecPublic(fuelRecipient, fuelReceived, fuelSecretHash)
     feeJuiceToken.forceApprove(feeJuicePortal, 0)

  4. token.forceApprove(tokenPortal, bridgeAmount)
     if isPrivate:
       (tokenKey, tokenIndex) = ITokenPortalPrivate(tokenPortal).depositToAztecPrivateFor(
           msg.sender, bridgeAmount, tokenSecretHash, cleanHands, passport)
     else:
       (tokenKey, tokenIndex) = ITokenPortal(tokenPortal).depositToAztecPublic(
           aztecRecipient, bridgeAmount, tokenSecretHash)
     token.forceApprove(tokenPortal, 0)

  5. emit BridgeWithFuel(aztecRecipient, tokenKey, tokenIndex, bridgeAmount, tokenSecretHash,
                         fuelKey, fuelIndex, fuelReceived, fuelSecretHash)
```

Note: `fuelRecipient` is a separate field from `aztecRecipient`. Public fuel: set both to user's L2 address. Private fuel (FPC path): set `fuelRecipient` to the FPC contract address on L2.

#### `bridge` flow (no swap)

```
user calls bridge(SimpleBridgeParams p, PermitParams permit)
  nonReentrant gate
  Validate: amount > 0, tokenPortal != address(0)

  1. _pullTokensWithWitness with witness where fuelAmount=0, fuelRecipient=0, routeHash=0

  2. token.forceApprove(tokenPortal, amount)
     if isPrivate: depositToAztecPrivateFor(msg.sender, amount, secretHash, cleanHands, passport)
     else:         depositToAztecPublic(aztecRecipient, amount, secretHash)
     token.forceApprove(tokenPortal, 0)

  3. emit Bridge(aztecRecipient, key, index, amount, secretHash)
```

#### Permit2 witness binding

The witness prevents a malicious relayer from substituting different bridge parameters after the user signs.

```solidity
bytes32 BRIDGE_WITNESS_TYPEHASH = keccak256(
  "BridgeWitness(address tokenPortal,address bridgeToken,uint256 totalAmount,"
  "uint256 fuelAmount,bytes32 aztecRecipient,bytes32 fuelRecipient,"
  "bytes32 tokenSecretHash,bytes32 fuelSecretHash,uint256 minFuelOutput,"
  "bytes32 routeHash,bool isPrivate)"
);
```

`routeHash = keccak256(abi.encode(path, zeroForOnes))` — binds the full swap path into the signature.

`BRIDGE_WITNESS_TYPE_STRING` is the concatenated EIP-712 type string passed to `permit2.permitWitnessTransferFrom`. It follows Permit2's `"<WitnessType> witness)<WitnessType>(...)<PrecedingType>(...)` format.

`_pullTokensWithWitness` calls `permit2.permitWitnessTransferFrom(permit, details, owner, witness, typeString, signature)` where `details.to = address(this)`.

`BridgeWitness` struct is ABI-encoded with `BRIDGE_WITNESS_TYPEHASH` prefix and hashed. For the `bridge` (no-fuel) call, `fuelAmount`, `fuelRecipient`, `minFuelOutput`, and `routeHash` are zeroed so the same typehash covers both flows.

#### Reentrancy

`ReentrancyGuard` from OpenZeppelin (lock pattern). Both `bridgeWithFuel` and `bridge` are `nonReentrant`. `sweep` is also `nonReentrant`.

Approvals are explicitly cleared to zero after each external call (`forceApprove(target, 0)`). This prevents residual approval misuse even if reentrancy guard is somehow bypassed.

#### sweep

Owner-only (`onlyOwner`), also `nonReentrant`. Sweeps ERC-20 (via `safeTransfer`) or native ETH (`call{value: bal}("")`). No whitelist — sweeps any address. Intended as an emergency safety valve for tokens stuck in the router between calls (should normally be zero).

#### governance — setSwapTarget

Owner can replace `swapTarget` (the `UniswapFuelSwap` contract) via `setSwapTarget(address)`. Emits `SwapTargetUpdated`. Zero address rejected. Uses `Ownable2Step` so ownership transfers are two-step.

#### Holonym-specific parts in SwapBridgeRouter

- `CleanHandsData` and `PassportData` structs (imported from top-level scope).
- `ITokenPortalPrivate` interface with `depositToAztecPrivate` / `depositToAztecPrivateFor`.
- `isPrivate` field in `BridgeParams` and `SimpleBridgeParams`.
- The `if (p.isPrivate)` branch calling `depositToAztecPrivateFor`.
- `cleanHands` and `passport` fields in both param structs.
- `isPrivate` flag in `BridgeWitness` — changes the Permit2 signature domain even if unused for a public-only bridge.

---

### 2. TokenPortal — canonical mechanism vs Holonym cruft

#### Canonical mechanism (reusable)

**Initialize (two-step deploy pattern):**
```solidity
constructor(address _initialOwner, ...) Ownable(_initialOwner) {
    DEPLOYER = _msgSender(); // stored for initialize() auth
    ...
}
function initialize(address _registry, address _underlying, bytes32 _l2Bridge) external {
    if (_msgSender() != DEPLOYER) revert Unauthorized();
    if (address(registry) != address(0)) revert AlreadyInitialized();
    registry = IRegistry(_registry);
    underlying = IERC20(_underlying);
    l2Bridge = _l2Bridge;
    rollup = IRollup(address(registry.getCanonicalRollup()));
    outbox = rollup.getOutbox();
    inbox = rollup.getInbox();
    rollupVersion = rollup.getVersion();
}
```
The split-initialize pattern allows the portal address to be pre-computed (e.g. for `l2Bridge` to reference it) and then the Aztec registry address set separately once known.

**Public deposit (L1 → L2):**
```solidity
function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
    external whenNotPaused nonReentrant returns (bytes32, uint256)
{
    DataStructures.L2Actor memory actor = DataStructures.L2Actor(l2Bridge, rollupVersion);
    bytes32 contentHash = Hash.sha256ToField(
        abi.encodeWithSignature("mint_to_public(bytes32,uint256)", _to, amountAfterFee)
    );
    underlying.safeTransferFrom(_msgSender(), address(this), _amount);
    (bytes32 key, uint256 index) = inbox.sendL2Message(actor, contentHash, _secretHash);
}
```

**Private deposit (L1 → L2):**
```solidity
bytes32 contentHash = Hash.sha256ToField(
    abi.encodeWithSignature("mint_to_private(uint256)", amountAfterFee)
);
inbox.sendL2Message(actor, contentHash, _secretHashForL2MessageConsumption);
```

**Withdraw (L2 → L1):**
```solidity
function withdraw(address _recipient, uint256 _amount, bool _withCaller,
    uint256 _l2BlockNumber, uint256 _leafIndex, bytes32[] calldata _path)
{
    DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
        sender: DataStructures.L2Actor(l2Bridge, rollupVersion),
        recipient: DataStructures.L1Actor(address(this), block.chainid),
        content: Hash.sha256ToField(abi.encodeWithSignature(
            "withdraw(address,uint256,address)",
            _recipient, _amount, _withCaller ? _msgSender() : address(0)
        ))
    });
    outbox.consume(message, _l2BlockNumber, _leafIndex, _path);
    underlying.safeTransfer(_recipient, amountAfterFee);
}
```

`_withCaller = true` constrains which L1 address can call `withdraw`. The L2 contract must have emitted exactly that caller address in the outbox message.

**Content-hash invariant:**
- L1→L2 public: `sha256ToField(abi.encodeWithSignature("mint_to_public(bytes32,uint256)", recipient, amount))`
- L1→L2 private: `sha256ToField(abi.encodeWithSignature("mint_to_private(uint256)", amount))`
- L2→L1 withdraw: `sha256ToField(abi.encodeWithSignature("withdraw(address,uint256,address)", recipient, amount, caller))`

These must match the L2 contract's `compute_message_hash` calls exactly. They are the cross-chain security boundary.

#### Holonym cruft (to DROP)

- `PassportData`, `CleanHandsData` structs
- `humanIdAttester`, `cleanHandsCircuitId`, `passportSigner` state + constructor params
- `passportNonces`, `cleanHandsNonces` mappings
- `trustedForwarders` mapping + `setTrustedForwarder` + `NotTrustedForwarder` error
- `depositToAztecPrivate(amount, secretHash, CleanHandsData, PassportData)` function
- `depositToAztecPrivateFor(depositor, amount, secretHash, CleanHandsData, PassportData)` function
- `_validatePrivateAttestations` internal
- `verifyCleanHandsSignature`, `verifyPassportSignature`, `_verifyPassportSignatureFor`
- `feeBasisPoints`, `feeRecipient`, `collectedFees` state + all fee logic
- `MAX_FEE_BASIS_POINTS` constant, `calculateFee`, `withdrawFees`, `updateFee`, `updateFeeRecipient`
- `updateAttestationConfig` admin function
- `rescueToken` admin function (consider keeping as sweep equivalent)

#### Clean portal spec

```solidity
contract <forked-portal> is Pausable, ReentrancyGuard, Ownable2Step {
    IRegistry public registry;
    IERC20 public underlying;
    IRollup public rollup;
    IOutbox public outbox;
    IInbox public inbox;
    bytes32 public l2Bridge;
    uint256 public rollupVersion;

    address private immutable DEPLOYER;

    constructor(address _initialOwner) Ownable(_initialOwner) {
        DEPLOYER = _msgSender();
    }

    function initialize(address _registry, address _underlying, bytes32 _l2Bridge) external {
        if (_msgSender() != DEPLOYER) revert Unauthorized();
        if (address(registry) != address(0)) revert AlreadyInitialized();
        // zero-address guards on all three params
        registry = IRegistry(_registry);
        underlying = IERC20(_underlying);
        l2Bridge = _l2Bridge;
        rollup = IRollup(address(registry.getCanonicalRollup()));
        outbox = rollup.getOutbox();
        inbox = rollup.getInbox();
        rollupVersion = rollup.getVersion();
    }

    // L1 → L2 public
    function depositToAztecPublic(bytes32 _to, uint256 _amount, bytes32 _secretHash)
        external whenNotPaused nonReentrant returns (bytes32 key, uint256 index)
    {
        require(_amount > 0, "zero amount");
        underlying.safeTransferFrom(_msgSender(), address(this), _amount);
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature("mint_to_public(bytes32,uint256)", _to, _amount)
        );
        (key, index) = inbox.sendL2Message(
            DataStructures.L2Actor(l2Bridge, rollupVersion), contentHash, _secretHash
        );
    }

    // L1 → L2 private (no attestation — user calls directly)
    function depositToAztecPrivate(uint256 _amount, bytes32 _secretHashForL2MessageConsumption)
        external whenNotPaused nonReentrant returns (bytes32 key, uint256 index)
    {
        require(_amount > 0, "zero amount");
        underlying.safeTransferFrom(_msgSender(), address(this), _amount);
        bytes32 contentHash = Hash.sha256ToField(
            abi.encodeWithSignature("mint_to_private(uint256)", _amount)
        );
        (key, index) = inbox.sendL2Message(
            DataStructures.L2Actor(l2Bridge, rollupVersion),
            contentHash,
            _secretHashForL2MessageConsumption
        );
    }

    // L2 → L1
    function withdraw(address _recipient, uint256 _amount, bool _withCaller,
        uint256 _l2BlockNumber, uint256 _leafIndex, bytes32[] calldata _path)
        external whenNotPaused nonReentrant
    {
        require(_amount > 0, "zero amount");
        DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
            sender: DataStructures.L2Actor(l2Bridge, rollupVersion),
            recipient: DataStructures.L1Actor(address(this), block.chainid),
            content: Hash.sha256ToField(abi.encodeWithSignature(
                "withdraw(address,uint256,address)",
                _recipient, _amount, _withCaller ? _msgSender() : address(0)
            ))
        });
        outbox.consume(message, _l2BlockNumber, _leafIndex, _path);
        underlying.safeTransfer(_recipient, _amount);
    }

    // Admin
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
    function sweep(address token, address to) external onlyOwner nonReentrant { ... }
}
```

**Can `depositToAztecPrivate` be called directly by the user (no trusted-forwarder relay)?**

Yes. The trusted-forwarder pattern exists solely because SwapBridgeRouter needs to call the portal _on behalf of_ the user (the tokens come from SwapBridgeRouter, not the user directly — they were pulled via Permit2). The `depositToAztecPrivateFor` variant exists so the portal can record the _original_ depositor's address for attestation verification against the user, not the router.

Once attestations are removed, there is no reason to distinguish depositor from `msg.sender`. The clean private deposit can be:
- Called directly by the user: `depositToAztecPrivate(amount, secretHash)` — user approves portal, portal calls `safeTransferFrom(msg.sender, ...)`.
- Called by SwapBridgeRouter on behalf of user: the router holds the tokens (pulled via Permit2) and calls `depositToAztecPrivate` — but the portal must pull from the router's balance. In this case the router approves the portal (`forceApprove(portal, amount)`) and the portal calls `safeTransferFrom(msg.sender, ...)` which pulls from the router. This is identical to the public flow — no `*For` variant needed.

Conclusion: the `depositToAztecPrivateFor` function and the trusted-forwarder map are entirely eliminated.

---

### 3. UniswapFuelSwap — V4 flash-accounting, swap interface, route validation, settlement cases

#### External interface

```solidity
function swap(
    address inputToken,     // ERC-20 to sell (caller must have approved this contract)
    uint256 inputAmount,    // exact input amount
    uint256 minOutput,      // slippage guard on FeeJuice output
    PoolKey[] calldata path, // ordered V4 pool route
    bool[] calldata zeroForOnes // swap direction per hop
) external nonReentrant returns (uint256 output)
```

Caller (SwapBridgeRouter) pre-approves `inputAmount` to `UniswapFuelSwap`, then calls `swap`. The adapter pulls tokens, executes the V4 flash-accounting round-trip, and transfers FeeJuice back to the caller.

#### V4 flash-accounting pattern

V4's `PoolManager.unlock(data)` grants the callback contract a transient "flash" context. No tokens move until `settle()` / `take()` calls inside the callback. The callback contract drives all settlement. Net-zero delta must be achieved before the context closes.

```
swap() → poolManager.unlock(data)
  → unlockCallback(data):
      for each hop i:
        delta = poolManager.swap(path[i], SwapParams{amountSpecified: -int256(currentAmount), ...})
        currentAmount = positive output delta of this hop
      _settle(inputToken, inputAmount, lastPoolNative, ...)
      poolManager.take(Currency.wrap(feeJuice), address(this), currentAmount)
      return abi.encode(currentAmount)
← output = abi.decode(result)
IERC20(feeJuice).safeTransfer(msg.sender, output)
```

`amountSpecified = -int256(currentAmount)` signals exact-input swap. Positive delta = tokens owed to this contract.

#### Route validation (`_validateRoute`)

1. First hop input must match `inputToken`. For native ETH pools `currency0 == address(0)` maps to WETH — requires `inputToken == weth`.
2. Last hop output must be `feeJuice`.
3. Native-ETH single-hop requires `inputToken == weth`.

This validation happens before the V4 unlock so bad routes fail cheaply.

#### Three settlement cases (`_settle`)

**Case A — All ERC-20 route** (e.g. USDC → WETH → AZTEC, all ERC-20 pools):
```
poolManager.sync(Currency.wrap(inputToken))
IERC20(inputToken).safeTransfer(poolManager, inputAmount)
poolManager.settle()
```

**Case B — Single-hop native** (e.g. WETH → ETH/AZTEC pool, `path.length == 1`):
```
IWETH(weth).withdraw(inputAmount)   // contract holds WETH from swap(), unwraps to ETH
poolManager.settle{value: inputAmount}()
```

**Case C — Multi-hop with last pool native** (e.g. USDC → WETH, then ETH/AZTEC):
```
// Settle input ERC-20 for first hop(s)
poolManager.sync(Currency.wrap(inputToken))
IERC20(inputToken).safeTransfer(poolManager, inputAmount)
poolManager.settle()

// Take intermediate WETH from pool, unwrap to ETH, settle for last hop
poolManager.take(Currency.wrap(weth), address(this), ethBridgeAmount)
IWETH(weth).withdraw(ethBridgeAmount)
poolManager.settle{value: ethBridgeAmount}()
```

The `ethBridgeAmount` is snapshotted as `currentAmount` when entering the last (native) hop.

#### Reusable verbatim?

**Yes, entirely.** `UniswapFuelSwap` has zero Holonym-specific logic. Its constructor takes `(poolManager, feeJuice, weth)` and it has no identity, fee, or attestation surface. The only owner-callable function is `sweep`. The bridge-evm package should copy it verbatim.

---

### 4. Deploy + seed scripts — constructor params and wiring

#### UniswapFuelSwap

```solidity
constructor(address _poolManager, address _feeJuice, address _weth)
```

Sepolia values (from scripts):
- `_poolManager`: `0xE03A1074c86CFeDd5C142C4F04F1a1536e203543`
- `_feeJuice` (AZTEC token): `0x762C132040fdA6183066Fa3B14d985ee55aA3C18`
- `_weth`: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`

`FEE_ASSET_HANDLER` (for minting FeeJuice in tests): `0x5602c39A6E9C5AcE589F64F754927bcDa4f4BFc9`

#### SwapBridgeRouter

```solidity
constructor(address _permit2, address _feeJuicePortal, address _swapTarget)
```

Sepolia values:
- `_permit2`: `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical Permit2, same on all chains)
- `_feeJuicePortal`: `0xd3361019E40026ce8a9745c19e67Fd3ACC10d596` (Holonym's Sepolia portal; use the Aztec canonical one)
- `_swapTarget`: address of deployed `UniswapFuelSwap`

No `initialize` step — fully self-contained at construction.

#### TokenPortal (clean version)

```solidity
constructor(address _initialOwner)
initialize(address _registry, address _underlying, bytes32 _l2Bridge)
```

- `_registry`: Aztec `IRegistry` on Sepolia — `0x52945C29D2788cCb076E910509C0449BfCBe29e6`
- `_underlying`: the ERC-20 being bridged (USDC, WETH, etc.)
- `_l2Bridge`: `bytes32` address of the Noir contract on L2 that handles the messages

#### Wiring sequence (from `DeployTokenPortalWithForwarder.s.sol`)

```
1. Deploy <forked-portal>(initialOwner)
2. portal.initialize(registry, underlying, l2Bridge)
3. Deploy SwapBridgeRouter(permit2, feeJuicePortal, uniswapFuelSwap)
// no trusted-forwarder step needed
```

The original script also calls `portal.setTrustedForwarder(address(router), true)` — this is eliminated since there is no `depositToAztecPrivateFor`.

#### Pool seeding (SeedUniswapPools.s.sol)

Creates two V4 pools for Sepolia testnet:
1. **ETH/AZTEC** — native ETH paired with FeeJuice, ~10,000 FeeJuice per ETH. Fee: 0.3%, tick spacing: 60. Liquidity: full-range ticks (`-887220` / `887220`). Uses `FeeAssetHandler.mint()` to obtain FeeJuice (each call mints 1,000).
2. **ERC20/WETH** — e.g. USDC paired with WETH, ~2,100 USDC per WETH. Fee: 0.3%, tick spacing: 60. Full-range liquidity.
3. Optional **ERC20/AZTEC direct** pool (set `SEED_DIRECT_POOL=true`).

The `PoolSeeder` / `PoolSetupHelper` contracts implement `IUnlockCallback` to seed liquidity inside V4's unlock context. They are ephemeral — deployed per script run and swept at the end. They can be copied verbatim as testnet bootstrap tooling.

Pool ordering invariant: `currency0 < currency1` by address sort. The scripts compute `c0 = erc20Token < WETH ? erc20Token : WETH`. Violating this reverts in PoolManager.

---

### 5. Foundry setup

#### foundry.toml

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.28"
via_ir = true
```

`via_ir = true` is required. The codebase uses `forceApprove` from OZ's `SafeERC20` and other patterns that need the IR pipeline for correct codegen.

#### Remappings

```
@oz/        → lib/openzeppelin-contracts/contracts/
@aztec/     → lib/aztec-contracts/l1-contracts/src
@uniswap/v4-core/ → lib/v4-core/
@test/      → test
```

#### Git submodules (lib/)

| Submodule | Purpose |
|---|---|
| `forge-std` | Foundry test framework |
| `openzeppelin-contracts` | OZ v5 (SafeERC20, Ownable2Step, ReentrancyGuard, Pausable, ECDSA) |
| `aztec-contracts` | Aztec L1 contract interfaces (IRegistry, IInbox, IOutbox, IRollup, DataStructures, Hash, IFeeJuicePortal) |
| `v4-core` | Uniswap V4 PoolManager interfaces + types (IPoolManager, IUnlockCallback, PoolKey, Currency, BalanceDelta, TickMath) |

The `bridge-evm` package needs all four as Foundry submodules or package-managed equivalents. The exact `aztec-contracts` commit must match the deployed testnet contracts — the `IInbox`, `IOutbox`, and `DataStructures` ABIs are version-sensitive.

---

## Invariants / gotchas

1. **Content-hash must match L2 contract exactly.** The Solidity `abi.encodeWithSignature("mint_to_public(bytes32,uint256)", ...)` string is hashed with `sha256ToField` and stored in the inbox. The L2 Noir contract computes the same hash. Any deviation (argument reorder, type mismatch, function name typo) silently produces a different hash and the L2 message can never be consumed.

2. **`rollupVersion` is baked at `initialize` time.** If Aztec deploys a new rollup version, the portal must be reinitialized or redeployed. The registry lookup (`registry.getCanonicalRollup()`) happens once. This is intentional — avoids relying on a mutable registry during message consumption (which could break in-flight messages).

3. **Permit2 witness type string format is exact.** The `BRIDGE_WITNESS_TYPE_STRING` must follow the Permit2 EIP-712 extension grammar precisely: `"<WitnessType> witness)<WitnessType>(<fields>)<PrecedingType>(<fields>)"`. A missing parenthesis or field reorder causes signature rejection silently from the user's perspective.

4. **`forceApprove` pattern.** OZ's `forceApprove` handles tokens that revert on non-zero → non-zero approval (like USDT). It sets to 0 first if needed. The explicit zero-reset after each external call is defense-in-depth, not just style.

5. **Balance mismatch check in `bridgeWithFuel`.** After the swap, the router verifies `fjBalAfter - fjBalBefore >= fuelReceived`. This catches a swap adapter that returns a dishonest output value. The balance check is done on `feeJuiceToken` (the `UNDERLYING()` of `feeJuicePortal`), not on some arbitrary token.

6. **`depositToAztecPrivateFor` pulls from `msg.sender` (the forwarder), not `_depositor`.** This is correct for the SwapBridgeRouter use case — the router holds the tokens. But it means the forwarder must have the tokens and have approved the portal. In the clean version (no forwarder), `depositToAztecPrivate` naturally pulls from `msg.sender` (the router or the user directly).

7. **CleanHands nonce is marked used even on failed verification (fallback to passport).** `test_DepositToAztecPrivate_InvalidCleanHandsWithValidPassport` confirms: `cleanHandsNonces[user][nonce] = true` is set before verification succeeds. This prevents replay across the clean-hands branch. Unleashed drops this entire subsystem.

8. **V4 `amountSpecified = -int256(currentAmount)`.** Negative = exact input in V4's swap params convention. The sign convention is opposite to V3. Passing a positive value means exact output (not what we want here).

9. **`sqrtPriceLimitX96` is set to extreme values** (`MIN_SQRT_PRICE + 1` for zeroForOne, `MAX_SQRT_PRICE - 1` otherwise). This disables the price limit check and allows the full input to be consumed. Correct for a swap adapter that enforces slippage via `minOutput` on the aggregate output, not per-hop.

10. **FeeJuice output is always ERC-20**, even when the intermediate route uses native ETH. The last `poolManager.take(Currency.wrap(feeJuice), ...)` always takes the ERC-20 AZTEC token. Native ETH is only used as an intermediate hop.

---

## TAKE vs DROP

### TAKE verbatim

| File | Notes |
|---|---|
| `[holonym] l1-contracts/src/UniswapFuelSwap.sol` | Zero Holonym specifics. Copy as-is into `packages/bridge-evm/src/`. |
| `[holonym] l1-contracts/src/interfaces/ISignatureTransfer.sol` | Stripped Permit2 interface. Copy as-is. |
| `[holonym] l1-contracts/src/interfaces/ITokenPortal.sol` | Minimal public interface. Copy as-is. |
| `[holonym] l1-contracts/script/SeedUniswapPools.s.sol` | The `PoolSeeder` helper + pool param constants. Adapt addresses for the bridge's testnet deployment. |
| `[holonym] l1-contracts/src/test/SwapBridgeRouter.t.sol` | The mock contracts (`MockPermit2`, `MockFeeJuicePortal`, `MockTokenPortal`, `MockSwap`) are clean and reusable for testing a stripped router. |
| `[holonym] l1-contracts/src/test/UniswapFuelSwap.t.sol` | Copy entirely. |
| `[holonym] l1-contracts/foundry.toml` | Copy as starting point for `packages/bridge-evm/foundry.toml`. |

### TAKE with modifications

| File | Required changes |
|---|---|
| `[holonym] l1-contracts/src/SwapBridgeRouter.sol` | DROP: `CleanHandsData`, `PassportData` structs; `ITokenPortalPrivate` interface; `isPrivate` field from both param structs and `BridgeWitness`; `cleanHands`/`passport` fields from `BridgeParams`/`SimpleBridgeParams`; the `if (p.isPrivate)` branch calling `depositToAztecPrivateFor`; `isPrivate` from `BRIDGE_WITNESS_TYPEHASH` and `BRIDGE_WITNESS_TYPE_STRING`. KEEP: everything else verbatim. |
| `[holonym] l1-contracts/src/TokenPortal.sol` | Full rewrite to clean spec (see §2 above). Keep: `initialize` two-step pattern, `depositToAztecPublic`, `depositToAztecPrivate` (signature stripped), `withdraw`, `pause`/`unpause`, `sweep` (rescue equivalent). DROP: all attestation + fee + forwarder machinery. |
| `[holonym] l1-contracts/script/DeployTokenPortalWithForwarder.s.sol` | Rename for the forked portal. Remove `feeBasisPoints`, `humanIdAttester`, etc. from constructor args. Remove `setTrustedForwarder` call. |

### DROP entirely

| File | Reason |
|---|---|
| `[holonym] l1-contracts/script/SetTrustedForwarderAllPortals.s.sol` | No trusted forwarders in the bridge. |
| `[holonym] l1-contracts/src/governance/interfaces/IMintableERC20.sol` | Only needed for the `FeeAssetHandler.mint` testnet call in seed scripts. Can import from `aztec-contracts` submodule directly. |
| All attestation-related state and logic in TokenPortal | `humanIdAttester`, `cleanHandsCircuitId`, `passportSigner`, both nonce maps, `_validatePrivateAttestations`, `verifyCleanHandsSignature`, `verifyPassportSignature`. |
| All fee-related state and logic in TokenPortal | `feeBasisPoints`, `feeRecipient`, `collectedFees`, `calculateFee`, `withdrawFees`, `updateFee`, `updateFeeRecipient`, `MAX_FEE_BASIS_POINTS`. |
| `[holonym] l1-contracts/src/test/TokenPortal.t.sol` | Must be fully rewritten for the clean portal (no attestation test cases). |

---

## Open questions for planners

1. **Which `aztec-contracts` commit to pin?** The `IInbox.sendL2Message` return type `(bytes32, uint256)` and the `DataStructures.L2Actor` shape must match whatever version is deployed on the target testnet. The Holonym repo pins a specific commit; Unleashed should pin the same Aztec version used by the faucet's existing packages. Check `packages/faucet/package.json` for `@aztec/*` version and find the matching L1 contract tag.

2. **`isPrivate` in the Permit2 witness.** If the bridge drops private deposits initially (public-only faucet bridge), the `isPrivate` field can be removed from `BridgeWitness` and the typehash simplified. If private deposits are in scope from day one, keep `isPrivate` but drop the attestation params from the structs.

3. **Should `depositToAztecPrivate` be exposed on the clean portal at all?** If the faucet only ever does public deposits (users receive funds in their public Aztec balance), the private variant can be omitted entirely from v1, simplifying the attack surface.

4. **FeeJuicePortal address for the target network.** The Holonym scripts hardcode Sepolia addresses. The bridge needs the canonical `IFeeJuicePortal` address for whatever Aztec testnet (or devnet) it targets. This should come from the Aztec registry or the `@aztec/l1-deployment-addresses` package if one exists.

5. **Do the Uniswap V4 pools already exist on the target testnet?** If the bridge targets a non-Sepolia Aztec testnet (e.g. a local devnet or a different public testnet), the V4 PoolManager address and the ETH/AZTEC pool may not exist. The seed scripts would need to run against whatever PoolManager is available.

6. **Sweep vs rescueToken.** The Holonym `TokenPortal` has `rescueToken(address, uint256)` that transfers a specified amount of an arbitrary token to `owner()`. The Holonym `SwapBridgeRouter` and `UniswapFuelSwap` have `sweep(address, address)` that transfers the full balance to a recipient. Recommend unifying to `sweep` pattern for the bridge contracts.

7. **`Ownable2Step` vs plain `Ownable`.** Holonym uses `Ownable2Step` with a custom `proposeOwnershipTransfer`/`cancelOwnershipTransfer` wrapper on top of `Ownable2Step`. This adds verbosity. For the bridge, plain `Ownable2Step` (using `transferOwnership` + `acceptOwnership` directly) is sufficient unless there's a specific reason for the extra events.
