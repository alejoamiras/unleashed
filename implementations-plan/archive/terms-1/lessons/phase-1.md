# terms-1 phase 1: mainnet root and renderer

- `App.test.ts` first loaded the real `MainnetRoot` through `vi.mock(..., importOriginal)`. Alone it
  passed after `vi.dynamicImportSettled()`; in the full suite the cold module load of the real root
  (its pages, the placeholder, the design icon) outran both `dynamicImportSettled` and a 1 s `vi.waitFor`.
  Raising the wait would hide a load race, so the test now stubs both roots, as it already stubbed the
  shell, and asserts only which root module each target evaluates. What the mainnet root renders (the
  placeholder and its three links at `/`, each document at its path) moved to `MainnetRoot.test.ts`,
  which imports the real component statically.
- `vi.stubEnv("VITE_TOOLS_TARGET", "mainnet")` + `vi.resetModules()` + a dynamic `import("./App.vue")`
  reaches the literal define test inside an SFC's `<script setup>`; the mock factories re-run per reset.
