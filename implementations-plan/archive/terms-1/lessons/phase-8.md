# Phase 8: the screen, the root, the policy edit

## The testnet build is unchanged

Built the testnet dist at head and again with the base's `apps/tools` and `packages/legal` restored
(`git checkout eb91752 -- apps/tools packages/legal`, then back to `HEAD`). Of 36 files, 34 are
byte-identical; `build.json` and `index.html` differ only in the build id (the commit each build ran from).
Every JS, CSS and asset file is identical, so the gate, its testids and the policy edit reach no testnet byte.
That needed the gate's testids outside the global `TESTIDS` (D19): that object ships whole to every build.

## Load

`src/contracts/bridge-generation.test.ts` (untouched) timed out at 5 s once in the full run at load 65 and
passed alone.
