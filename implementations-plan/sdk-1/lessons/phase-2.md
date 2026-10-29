# Arc a2: the SDK package

- **2.1: the 7-day gate blocks a fresh install on a new Aztec line.** Adding a workspace re-resolves every package it
  declares, and the 6.0.0 line was younger than seven days, so `bun install` refused all of it. A local
  `minimumReleaseAgeExcludes` naming each locked `@aztec-labs`/`@aztec-foundation` 6.0.0 package let the lockfile
  gain the workspace; `bunfig.toml` was restored before committing and `bun install --frozen-lockfile` then passed.
- **2.1: esbuild resolves every member of a barrel it reaches.** `"sideEffects": false` lets it drop unused members
  from the output, not skip resolving them, so a Worker importing one ABI from `./protocol` pulled the Aztec graph
  and failed on `tty`. The relayer imports the viem-only `./l1` entry, and bridge-core's bundle guard walks a whole
  SDK entry rather than the imported symbols.
- **2.1: a vitest mock replaces an entry for every importer of that entry.** While the moved modules lived in
  bridge-core, a full-replacement mock of `@unleashed/bridge-core` reached only the test's subject; once bridge-core's
  own modules import `@unleashed/sdk/protocol`, a full mock of that entry starves them too. A mock that replaces one
  symbol spreads `importOriginal`.
- **2.1: a codemod resolves each symbol to where it is declared, not where it is re-exported.** Ranking re-export
  sites equal to declarations sent two symbols to a re-exporting module.
- **2.1: the imports scan skips comments.** Doc comments quote `import("…")` specifiers the module never imports; the
  SDK's declared-imports guard flagged two before it stripped comments.
- **2.4: a field-sized hex is the only valid fake hash.** A message hash or a transaction hash above the BN254
  modulus makes `Fr.fromString` throw; the readiness read swallows that as "not ingested" and the gate polls for 30
  minutes, which reads as a hung test. Fakes use `0x0c…`-style values below the modulus.
- **2.4: a type import counts in the static-graph guard.** `capabilities.ts` took `BridgeToken` as a type from
  `bridge/token.ts`, which reaches the hub artifact; the guard walks every import statement, so the root entry
  failed it. A structural parameter type keeps the root clear.
- **2.4: a moved helper takes its own imports with it.** The app's tests mocked `hubTokenFor` at the SDK barrel; once
  `probeHubClaim` moved into the SDK it calls its sibling directly, so the app's tests mock the probe itself.

