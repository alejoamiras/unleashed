import { Buffer } from "node:buffer"

// Aztec packages assume Node globals exist; jsdom provides DOM, not these.
// Without the shim the SDK throws ReferenceError on import of pino, util,
// or anything that touches process at module top-level.
if (typeof globalThis.process === "undefined") {
	;(globalThis as unknown as { process: NodeJS.Process }).process = {
		env: {},
		platform: "browser",
		versions: { node: "v20.0.0" },
		browser: true,
		nextTick: (cb: () => void) => setTimeout(cb, 0),
	} as unknown as NodeJS.Process
}
if (typeof globalThis.global === "undefined") {
	;(globalThis as unknown as { global: typeof globalThis }).global = globalThis
}
if (typeof globalThis.Buffer === "undefined") {
	;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
}
