# PoCs — bridge red-team

## F-001 (CRITICAL) — live portal re-initialization — VERIFIED PASSING

`PortalReinit.t.sol` is a Sepolia-fork Foundry test that calls `initialize` on the REAL deployed
portal (`0x9c41d1DD627ed53E25702590ab974d9DfA0c11Ea`) from a random attacker EOA and asserts it
repoints `underlying`/`l2Bridge`/`registry`. Read-only local fork — no real tx, no funds move.

Run:
```
cp PortalReinit.t.sol ../../../../packages/bridge-evm/test/   # drop into the Foundry project
cd ../../../../packages/bridge-evm && SEPOLIA_RPC_URL=<rpc> ~/.aztec/current/bin/forge test --match-path test/PortalReinit.t.sol -vvv
```

Verified — PASS. Output:
```
live underlying (before): 0xA40A2FE147b7e96325d7c7D974B1f11C3ED82c68
live l2Bridge (before):   0x0e31670a54cac23d4d74b0d83c44797369a4a2d08a375aab1514283623e2748e
F-001 CONFIRMED: live portal is permissionlessly re-initializable
[PASS] test_F001_attacker_reinitializes_the_LIVE_portal()
```

After the fix (forked portal with an already-initialized guard), flip the assertion to
`vm.expectRevert` on the second `initialize` — it becomes the regression test.

PoC sketches for the other top findings are in `../report.md` (F-002 mint→exit→withdraw drain via
aztec.js/TXE; F-004 malicious swapTarget extraction via a Foundry router test).
