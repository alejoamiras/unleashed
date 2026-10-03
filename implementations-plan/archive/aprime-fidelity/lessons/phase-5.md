# Phase 5 — Token marks (Q2 A)

## What was done

- **`token-mark.ts`:** `BY_KEY` holds the five exact chain-1 keys the sprite carried, same colours; `BY_MANIFEST_SYMBOL` maps USDC, USDT, WETH, WBTC and cbBTC to the same `Brand` objects. `markOf` grants a brand only from `BY_KEY` or, when `source === "manifest"`, from `BY_MANIFEST_SYMBOL`; the file's one comment states that invariant. Both tables are `Map`s, so a symbol such as `constructor` cannot reach a prototype key. Letters: the brand's board letters (USDC "US", USDT "UT", WETH "WE"; WBTC "WB" and cbBTC "CB" kept from the sprite), otherwise the first two code points of `safeDisplay(symbol)`, upper-cased, "??" when nothing is left.
- **`TokenMark.vue` + sprite removal:** a 32px `--ul-notch-2` span; brand fill and ink as constant hex from the table, otherwise `--ul-raised` with `--ul-ink`; Next 800 11. It carries `sendTokenLogo` when branded and `sendTokenMonogram` otherwise, and replaces both the `TokenTile` mark and the lookup's duplicated mark in `TokenStep`. `token-sprite.ts` (+ test), `SpriteSheet.vue` and `assets/token-sprite.svg` are deleted, with `<SpriteSheet/>` in `TokenList` and its `testid-coverage` entries. The stale "committed sprite" wording in `send-model.ts`, the tools README and a `token-list.ts` comment now describes the brand/grey marks.
- **Tests:** new `token-mark.test.ts` (exact chain-1 key → brand whatever the source; manifest USDC on 31337 and 11155111 → brand; a `list` or `pasted` "USDC" at another address → none; manifest EURC and PXO → none; bidi-stripped "ZK", a zero-width-only symbol and an empty one → "??"). `TokenTile.test.ts`: the sprite, fallback and hashed-hue cases became one branded render (manifest USDC on Sepolia, blue fill, "US") and one grey render (a list "USDC" at `0x6666…`, no inline style). `TokenList.test.ts` loses the sprite-adoption case. `testid-coverage.test.ts` registers `TokenMark` as an inert component. `specs/tokens-hostile.spec.ts`, after the collision check: the manifest USDC tile contains `sendTokenLogo`; the fake "USDC" at `0x6666…` contains `sendTokenMonogram` and no `sendTokenLogo`.

## Attempts and notes

1. `testid-coverage.test.ts` also asserts that every `.vue` in `components/send` has a case; the first run failed on the new `TokenMark`. It got a case and joins the gas-only card as the sweep's allowed inert component (the mark is `aria-hidden` and has no control).
2. The first commit swept up the staged `git rm` of the sprite files, which would have left a commit where `TokenTile` imports a deleted module. It was unpushed and mine, so it was reset (`git reset HEAD~1`, working tree kept) and re-committed as two commits that each build.

## Deviations from the plan

- **`markOf` takes `{ logoKey, symbol, source }`, not `{ chainId, address, symbol, source }`.** The phase step keys the table by `logoKey` already, and the lookup state carries `logoKey` but no chain id; taking the key avoids adding a field to `LookupState`. The key is lower-cased before the table read, so the exact-identity rule is unchanged.
- **Grey letters count code points, not UTF-16 units**, so a surrogate pair is never split. The previous `slice(0, 2)` could split one.

## Validation gate

Run (`impl/pg5.sh` and `impl/e2e5.sh`, concurrently; each command's exit code logged):
- PG: `bun run lint` exit 0 (complexity-baseline OK). `bun run typecheck:all` exit 0. `bun run test:all` exit 0 (design 217, bridge-core 447 + 1 skipped, tools 1477 in 105 files: the sprite suite and three sprite/hue tile cases left, seven mark cases arrived). `bun run --cwd apps/tools test:e2e` exit 0 (30 tests).
- Baseline: `git diff --exit-code <rev> -- scripts/complexity-baseline/manifest.json` exit 0; the same from the plan base exit 0.
- `git grep -n -e token-sprite -e SpriteSheet -e monogramHue -- apps/tools/src` printed nothing (exit 1).
- `bash apps/tools/scripts/e2e/agent.sh specs/tokens-hostile.spec.ts specs/tokens.spec.ts` exit 0: `5 passed (4.1m)`, no retries. Cell 34b proved the manifest USDC tile branded and the list's fake "USDC" at `0x6666…` grey through the real UI.

## Board vs capture

No tour in this phase's gate (arc 2's tour runs in phase 6). Values checked against the BridgeToken and Components board sources: tile 32×32 with the 2px notch, Atkinson Hyperlegible Next 800 11px; USDC #2775CA, USDT #26A17B, WETH #627EEA with #FFFFFF letters; an unknown token (ZK) #EDEDEA on #1D1D23, which are `--ul-ink` on `--ul-raised` in dark.

## Flags for owner sign-off

- **Testnet and sandbox USDC/USDT render in brand colours** (Ask A2, D27): the manifest rows are "our list". The stricter reading, mainnet addresses only, is a one-table edit.
- **A grey mark on a raised surface loses its tile edge.** The lookup panel and a hovered row are `--ul-raised`, the same fill as a grey mark, so only the letters show there. The board draws only a brand mark (DAI) in the lookup and no hovered grey row. A pasted DAI renders grey, not the board's #F5AC37 (Q2 A).
- **White letters on USDT green and WBTC orange** follow the boards and the old sprite; they are below 4.5:1 but the mark is `aria-hidden` and the symbol is printed beside it.
