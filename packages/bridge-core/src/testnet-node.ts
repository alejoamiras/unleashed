/**
 * The v6 testnet Aztec node every testnet script and the tools build talk to. A dRPC endpoint whose
 * key is public by design (testnet-only, separate from mainnet's); rotating it is this one constant,
 * plus the tools app's Node-safe copy in `network-targets.ts`, which a test holds equal. The testnet
 * CSP pins this exact path, and CSP stops path-matching after a redirect, so the endpoint must answer
 * without one. `AZTEC_NODE_URL` overrides it in every script.
 */
export const TESTNET_NODE_URL = "https://lb.drpc.live/aztec-testnet/Ak_eT5HA2kbyqamqGTF702daoH37vEsR8YYxjmVXwXgc"
