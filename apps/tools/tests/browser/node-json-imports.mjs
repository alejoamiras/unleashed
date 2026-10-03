// Node refuses a JSON module imported without `with { type: "json" }`; Bun and Vite accept it, and
// the `@aztec-labs/*` lazy entrypoints (`@aztec-labs/accounts/testing`, the lazy account-contract providers)
// import their artifacts that way on purpose ("incompatible with NodeJS" by their own comment). The
// Playwright runner is the one Node process that loads the harness, so it registers this hook.
import { register } from "node:module"

register("./node-json-imports-hook.mjs", import.meta.url)
