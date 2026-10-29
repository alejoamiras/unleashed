# @unleashed/legal

The Terms of Use and the Privacy Policy of the Unleashed mainnet app, as typed data, and the public
URL of each. Data only: no renderer, no dependency.

- The landing (`apps/landing`) renders each document to a static page at its URL (`/terms`,
  `/privacy`), every string escaped at build time.
- The mainnet app links to those URLs from its placeholder. Its post-build check proves the mainnet
  dist carries both URLs and no other target carries either.
- A document is closed data (`document.ts`): paragraphs, lists and one providers table. A new block
  kind needs a renderer case in the landing first.
- An edit to either text updates its `updated` date. The Privacy Policy names every origin the mainnet
  app reaches; `apps/tools/src/lib/privacy-providers.test.ts` pins its providers to the mainnet
  target, so an endpoint added there fails until the policy names it.

The texts are drafts for the owner and the owner's lawyer, not legal advice.
