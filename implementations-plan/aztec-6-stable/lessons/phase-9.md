# Phase 9: the live generation

The window opened after Phase 7's gate (`323041d`). From here to Phase 10's final verify, only
`OPERATIONAL_ALLOWLIST` files change, one signing run at a time.

## Step 1: the build and the intent

`bun packages/bridge-core/scripts/gen-remappings.ts` left `remappings.txt` unchanged, and
`/opt/foundry/bin/forge build --force --root contracts/bridge/evm` exited 0 (lint notes only). That binary
is the one a keyed run resolves (D18):

```
forge Version: 1.4.1-v1.4.1
Commit SHA: cf7746048646f2ecff48246dd61e265e49ab16f0
```

No sandbox and no other forge build runs from here to the final verify.

## Spend (gross, per broadcast group)

| Group | Run | ETH |
|---|---|---|
