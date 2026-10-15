# Phase 10 — the arc 2 quality loop

Codex `gpt-6.1-sol`, high effort, one session. Main had not moved since arc 2 was cut, so there was no rebase.

## Round 1: the deps, Noir and docs half (`a443510`)

"No material findings at `a443510` — high confidence." Two low findings, both fixed before the intent was built:

1. `aztec-line.test.ts` checked resolved versions but not declarations: a `^` specifier on `bb.js` or the TXE
   server's `@aztec-labs/txe` passed. Fixed in `f377f3a`, which checks every Aztec declaration in every manifest,
   proven red on both mutations.
2. The class-id tripwire's comment claimed CI has no nargo and that the test pins a sha256. Fixed in `3cd0357`.

## Round 2: the FPC and identity half (`3cd0357..4260741`), after the live window opened

"No material findings — high confidence. Both round-one fixes confirmed." "No class-a finding."

Both findings touch files outside `OPERATIONAL_ALLOWLIST`, so they wait for the window to end:

1. Low, class b: `check-fpc-version.ts` treats a malformed `node_getContract` result (`false`, `0`, `""`) as
   absence. Only `null`/`undefined` should be. The FPC address and what is deployed are unaffected.
2. Low, class c: the sandbox smoke's last label says the PrivateFPC "paid every flow above". It should read
   "PrivateFPC remains unpublished after all flows".
