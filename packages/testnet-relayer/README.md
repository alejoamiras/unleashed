# @unleashed/testnet-relayer

A Cloudflare Worker, testnet only, that fills the app's Base Sepolia → Sepolia Across sends. Across's own testnet
relayer cannot fill them (see [`bridge-generation`](../../.claude/skills/bridge-generation/SKILL.md) § The live
canary), so every testnet send names one filler as `exclusiveRelayer` until its `fillDeadline`, and this Worker
signs as that filler. Each minute its cron trigger runs `relayOnce` ([`src/run.ts`](src/run.ts)): one stateless
run that fills at most one deposit. It keeps no state between runs: a crash or a skipped minute loses nothing a
later run cannot redo while the deposit is fillable.

The Worker answers nothing over HTTP (no route, no `workers.dev` URL), refuses any chain but Base Sepolia (84532)
and Sepolia (11155111) before any other read, and refuses a key that does not derive `TESTNET_FILLER`. The fill
itself is `fillSourceDeposit` from `@unleashed/bridge-core/across-fill`, the same code `fill-testnet.ts` runs.

## What it fills

A deposit is admitted only in the exact shape the app builds (`classify`, [`src/select.ts`](src/select.ts)); any
other is ignored with its reason:

| Reason | The deposit is ignored unless |
|---|---|
| `destination` | it goes to Sepolia |
| `relayer` | it names the filler as `exclusiveRelayer`, exclusive until `fillDeadline` |
| `token` | both tokens are the manifest's Base Sepolia and Sepolia USDC |
| `recipient` | it pays LI.FI's `ReceiverAcrossV4` |
| `amount` | its input is positive and at most 8 USDC |
| `output` | its output is positive and at most the app's terms for that input (a 25 % fee) |
| `window` | `fillDeadline − quoteTimestamp` is at most 7,200 s |
| `message` | its message is at most 2,048 bytes and decodes to one LI.FI step that moves exactly the output to a nonzero receiver |
| `router` | that step calls the manifest's `DepositRouter` or one of its legacy routers |
| `intent` | the router's intent pulls exactly the output, in the output token |

A run then drops the deposits the Sepolia pool already filled (matched by full relay identity, never by deposit
id alone), those within 120 s of their deadline, and those larger than the float. It tries the rest largest
first, at most eight a run, and moves to the next after a refusal that wrote nothing.

## Log lines

One JSON line per event ([`src/log.ts`](src/log.ts)), in Workers Logs. No line carries a key or a URL.

| `event` | Meaning |
|---|---|
| `filled` | a fill landed (`fillTx`, `relayHash`, `srcTx`, amounts) |
| `already-filled` | the pool shows the relay filled by the time of the fill |
| `skipped` | a deposit passed over: `deadline` or `balance`, or a write-free `FillRefused` reason |
| `failed` | the run ended on an error that may have written (an approval, a reverted fill) |
| `ignored` | a deposit outside the envelope, logged only while within 30 blocks of the source head |
| `low-gas` / `low-inventory` | the filler holds under 0.01 ETH / under 6 USDC on Sepolia |
| `busy` | the filler has a pending transaction: the run sends nothing |
| `gas-price` | a fill at the gas cap could cost over 0.005 ETH: the run sends nothing |
| `refused` | the chain, the key or the manifest is not the testnet relayer's: nothing was read or signed |

## Known limits

1. Every fill spends the float, which Across testnet never repays: legitimate sends en masse can empty it, and
   later sends stay in the source pool.
2. A deposit missed while the Worker is down past its deadline stays in the source pool.
3. A fill that fails after its approval is retried each minute until its deadline, at an approval and a revoke
   each, and as the largest candidate holds smaller ones back meanwhile.
4. Overlapping runs (one stalled past a minute) can waste gas on replaced or reverted transactions. They cannot
   lose tokens: the pool pulls from the filler only inside the filler's own `fillRelay`, once per relay.

The key is a dedicated one with a small float, never the canary's. Anyone who can deploy to the Cloudflare account
can deploy code that reads the secret; the loss is the float.

## The owner's runbook

The agent never holds the key; every step below is the owner's.

1. **Create the key.** The agent files `env-exec request --template
   packages/testnet-relayer/testnet-relayer.env.example --slug relayer-address -- bun
   packages/testnet-relayer/scripts/relayer.ts address`. The owner runs `op-remote create <host> <id>`, which
   generates the key into 1Password, and approves; the run prints the address, never the key. `TESTNET_FILLER` is
   then set to that address in its own PR.
2. **Create the Worker.** In the Cloudflare dashboard, create it from Workers Builds with the settings in
   [`wrangler.jsonc`](wrangler.jsonc)'s header (root directory `packages/testnet-relayer`), and paste the key from
   1Password into the secret `RELAYER_PRIVATE_KEY`. Cron runs need Workers Paid: a run that fills makes up to about
   a hundred subrequests, and the free plan allows 50 and 10 ms of CPU.
3. **Fund it** on Sepolia: about 0.02 ETH, and 20 USDC from faucet.circle.com. It needs nothing on Base Sepolia.
4. **Check it.** Once `TESTNET_FILLER` names the key, send USDC from Base Sepolia in the testnet app and look for
   `filled` in the Worker's logs.
5. **Run it.** Top up on `low-inventory`. To stop it, remove the cron trigger in the dashboard. While the Worker is
   down, a keyed run of `bun packages/testnet-relayer/scripts/relayer.ts once` on the same template fills one
   deposit per call from the owner's machine, with the same code.

Until `TESTNET_FILLER` names the key, the Worker refuses every run: its key does not derive the filler.

## Scripts

| Script | What |
|---|---|
| `bun run test` | Unit tests: the route, `classify`, `relayOnce` over stubbed chains, the key, the config, and a `wrangler deploy --dry-run` bundle. |
| `bun run test:integration` | `relayOnce` against two anvils at the two chain ids, with the repository's `TestSpokePool` and `MintableERC20` copied to the pinned pool and USDC addresses: a fill and an idle rerun, an ignored deposit, a pass-over and restock, a forged fill, an overlap, the deadline margin. Needs `forge build` in `contracts/bridge/evm`; CI runs it in `_bridge-contracts.yml`. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run worker:deploy` | `wrangler deploy`: Workers Builds' deploy command, never run by hand. |
