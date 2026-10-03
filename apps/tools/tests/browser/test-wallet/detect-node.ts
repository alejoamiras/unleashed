// The node-polyfills `process` shim makes detect-node report Node, which sends @aztec-labs/foundation's
// pino logger down the worker-thread transport; the browser transport is the one that exists here.
export default false
