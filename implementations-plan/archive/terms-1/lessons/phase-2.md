# Phase 2: the dist rule, and the move to D11

- **The 7-day gate re-gates young pins on any manifest edit.** Adding `@unleashed/legal` to two
  `package.json` files made `bun install` refuse the 17 Aztec 6.0.0 packages (published under 7 days
  ago). Per `bunfig.toml`, the exclude went in locally for one install and `bunfig.toml` was restored;
  `bun install --frozen-lockfile --force` then passed. The `bun.lock` diff is the workspace entry and
  the two links only.
- **A workspace package imported by `vite.config.ts` needs `.ts` relative imports.** Vite's config
  bundler externalizes the linked package and Node loads it natively, so `./privacy` fails
  (`ERR_MODULE_NOT_FOUND`). The package uses `./privacy.ts`; `apps/tools/tsconfig.json` gained
  `allowImportingTsExtensions` (the landing already had it) so `vue-tsc` accepts the package's files.
- **`content.ts` is in the landing's script bundle.** Importing the documents there put their text
  into `main.ts`'s chunk (40,119 bytes, over the 40,000 budget). The pages' data moved to the
  build-time `src/legal-pages.ts` (19,648 bytes after), and the guard now refuses any `.js` carrying a
  document id.
- **Tree-shaking holds in tools.** The mainnet placeholder chunk is 1,447 bytes and carries only the
  `LEGAL_URLS` map; `"sideEffects": false` plus a constant object keeps the document text out.
- Gate: lint, `typecheck:all`, `test:all` (tools 1811, landing 83, legal 3), both tools builds with
  `verify:build-target` (testnet: links absent, no placeholder chunk; mainnet: links present), the
  landing build and guard, the landing browser smoke (30 passed, the live case skipped),
  `test:ci-gating`, `lint:actions`.
