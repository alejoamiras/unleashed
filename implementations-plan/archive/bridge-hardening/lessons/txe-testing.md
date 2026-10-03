# Arc 9 — TXE testing: what works, and every gotcha on the way

The TokenBridge now has a 16-test TXE suite (`token_bridge/src/test/`, runner:
`contracts/bridge/aztec/scripts/run-txe-tests.sh`) covering claim_public/claim_private happy
paths, the F-007 recipient-commitment redirect rejection, wrong-secret/salt, pause gates,
nullifier replay, zero-amount, proxy mint guards (incl. owner-has-no-mint-power), single-shot
`set_bridge`, and both exits with real authwits.

## The invocation that actually works

```bash
# terminal 1 (or let run-txe-tests.sh do it)
node node_modules/@aztec/txe/dest/bin/index.js        # TXE oracle server, port 8080
# terminal 2
aztec-nargo test --force --oracle-resolver http://127.0.0.1:8080 \
  env NARGO_FOREIGN_CALL_TIMEOUT=1200000
```

## Gotchas (each cost real time)

1. **aztec-nargo alone cannot run TXE tests**: its test runner returns
   `0 output values were provided as a foreign call result for N destination slots` for EVERY
   oracle. TXE is a separate HTTP server (`@aztec/txe`); nargo connects via `--oracle-resolver`.
   Upstream CI: `noir-projects/scripts/run_test.sh` sets exactly this flag.
2. **Run the server under NODE, never bun** — native lmdb bindings crash bun silently.
3. **`NARGO_FOREIGN_CALL_TIMEOUT` must be raised** (upstream CI uses 300000; we use 1200000 ms):
   heavy TXE calls exceed the default and surface as resolver "Out of memory".
4. **Dependency artifacts resolve from THIS package's target/** as
   `<dependency_package_name>-<ContractName>.json`. We stage:
   - `token_minter_proxy-TokenMinterProxy.json` ← sibling crate's committed artifact
   - `token_bridge_contract-TokenBridge.json` ← own committed artifact
   - `token_contract-Token.json` ← **transpiled** artifact shipped by the npm package
     `@aztec-foundation/aztec-standards` (already a dep of bridge-core). Note the package name
     is `token_contract` even though our Nargo.toml aliases it `token`.
5. **Artifacts must be AVM-transpiled**: plain `nargo compile` output is rejected with
   "Contract's public bytecode has not been transpiled". Only `aztec compile` (or the
   foundation artifacts package) produces deployable bytes.
6. **v5.0.1 standards Token ctor arity**: `constructor_with_minter(name: str<31>,
   symbol: str<31>, decimals: u8, minter, auth_contract)` — 5 args; strings are EXACTLY 31 chars.
7. **Authwit direction for exits**: the token sees msg_sender == PROXY, so public exits need
   `add_public_authwit_from_call(env, user, proxy, Token.burn_public(...))`; private exits use
   `add_private_authwit_from_call` likewise.
8. **nargo caches aggressively**: after editing test modules, ALWAYS run with `--force`, else a
   stale success silently reports 0/N tests.
9. `should_fail` tests pass VACUOUSLY if any earlier step reverts — when a suite goes green,
   re-check that positive-path tests exist for the same behavior (they do here).
10. Private-balance assertions need `create_contract_account()` recipients (full key set) +
    `env.execute_utility(Token::at(t).balance_of_private(addr))`.
11. **The suite does not scale past roughly two dozen tests without bounding concurrency.** The
    oracle's lmdb store opens with `maxReaders 2` while nargo defaults to one test thread per
    core; beyond that the native binding aborts the whole server with
    `libc++abi: terminating due to uncaught exception of type Napi::Error`. Every test still in
    flight then reports `Failed calling external resolver. client error (Connect)`, which reads
    like a suite-wide code breakage rather than a capacity limit. The runner now passes
    `--test-threads 4` (override with `TXE_TEST_THREADS`). This is also why the suite is NOT a
    CI gate yet — a required check that dies on test count is worse than no check.
12. **`curl -sf` is not a valid readiness probe.** TXE speaks JSON-RPC and does not answer a bare
    GET, so `-f` reports failure even once it is serving. The original wait loop therefore never
    succeeded — it simply exhausted its iterations and ran the suite anyway, which is why it
    looked like it worked. Probe the TCP socket instead.
13. **Resolve dependency artifacts through a declaring workspace**, never `$repo_root/node_modules`
    — this repo uses bun's isolated linker and has no hoisted root. `bridge-core` declares
    `@aztec-foundation/aztec-standards`, so the Token artifact resolves under its `node_modules`.
14. **Guard tests on PRIVATE entrypoints need a funded, authorized caller** or they fail earlier
    than the guard and prove nothing. `burn_private` nullifies notes during private execution and
    the pause gate on `exit_to_l1_private` runs in the ENQUEUED public assert, so an unfunded
    attempt dies on the missing note or a missing authwit — with a bare `should_fail` that still
    reports green. `utils::fund_private` exists for this.
15. Revert strings worth knowing, since none of them is a named assert: a replayed private claim
    gives `No non-nullified L1 to L2 message found`; a second `PublicImmutable.initialize` gives
    `Attempted to emit duplicate nullifier`; burning more than the balance gives
    `attempt to subtract with overflow`.

Point 9 deserves emphasis after this round: a bare `should_fail` is satisfied by ANY failure,
including a dead oracle. Two tests added during the revival passed for exactly that reason before
the concurrency fix landed. Always pin `should_fail_with`.

## Fuzzing

nargo auto-fuzzes parameterized `#[test]` fns (randomized args per run) — the keystone crate
uses this for `derive_claim_secret` neighbor-injectivity. TXE fns can take fuzzed params the
same way once the harness runs.
