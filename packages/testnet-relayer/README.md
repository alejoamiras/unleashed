# @unleashed/testnet-relayer

A Cloudflare Worker, testnet only, that fills the app's Base Sepolia → Sepolia Across sends. Across's own testnet
relayer cannot fill them (see [`bridge-generation`](../../.claude/skills/bridge-generation/SKILL.md) § The live
canary), so every testnet send names one filler as `exclusiveRelayer` until its `fillDeadline`, and this Worker
signs as that filler. Each minute its cron trigger makes up to four passes 15 s apart, one at a time
([`src/schedule.ts`](src/schedule.ts)); each pass is `relayPass` ([`src/run.ts`](src/run.ts)), which fills at most one
deposit. No state outlives a pass: a crash or a skipped minute loses nothing a later pass cannot redo while the
deposit is fillable.

The Worker answers nothing over HTTP (no route, no `workers.dev` URL), refuses any chain but Base Sepolia (84532)
and Sepolia (11155111) before any other read, and refuses a key that does not derive `TESTNET_FILLER`
(`packages/bridge-core/src/across-self-built.ts`): this Worker's own key, never the canary's. The fill itself is
`fillSourceDeposit` from `@unleashed/bridge-core/across-fill`, the same code `fill-testnet.ts` runs.

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

A pass reads every Base Sepolia block stamped within 7,800 s before Sepolia's head time: the 7,200 s window and
600 s more, found by binary search over block timestamps ([`src/window.ts`](src/window.ts)), never by a block count.
It reads at most 100,001 blocks, in 2,000-block `getLogs` chunks, so a swapped endpoint must serve that range
(PublicNode serves 50,000; Base's own endpoint 201). A wider window, a source head stamped before it, or reads still
running after 45 s, or past the run's end, fail the pass before any send.

It then drops the deposits the Sepolia pool already filled (matched by full relay identity, never by deposit id
alone), those within 120 s of their deadline, and those larger than the float. It tries the rest largest first, at
most eight a pass, and moves to the next after a refusal that wrote nothing. Before each try it checks for a pending
transaction and the fee ceiling, and it starts no try with under 25 s left before the run's end, 2 s before the next
cron.

## Log lines

One JSON line per event ([`src/log.ts`](src/log.ts)), in Workers Logs. No line carries a key or a URL.

| `event` | Meaning |
|---|---|
| `filled` | a fill landed (`fillTx`, `relayHash`, `srcTx`, amounts) |
| `already-filled` | the pool shows the relay filled by the time of the fill |
| `skipped` | a deposit passed over: `deadline` or `balance`, or a write-free `FillRefused` reason |
| `failed` | the pass ended on an error: a read that kept failing, a window it cannot cover, reads past their deadline, or one that may have written (an approval, a reverted fill) |
| `ignored` | a deposit outside the envelope, logged by the passes within 30 s of its block |
| `low-gas` / `low-inventory` | the filler holds under 0.01 ETH / under 6 USDC on Sepolia |
| `busy` | the filler has a pending transaction: the pass sends nothing |
| `gas-price` | a fill at the gas cap could cost over 0.005 ETH: the pass sends nothing |
| `late` | under 25 s of the run were left for a try, or none for a pass: nothing is sent, and the next run's first pass tries |
| `refused` | the chain, the key or the manifest is not the testnet relayer's: nothing signed, nothing read beyond the two chain ids |
| `restock-requested` | Circle's faucet API answered `204` to a USDC drip request (`balance` before it); the next runs' balance shows the drip |
| `restock-refused` | the drip request, or the balance read before it, failed: Circle's status, `code` and message, the key never in it |

## Restock

With the optional secret `CIRCLE_API_KEY` set, a run may ask Circle's faucet API (`POST /v1/faucet/drips`) for a
USDC drip to the filler on Ethereum Sepolia ([`src/restock.ts`](src/restock.ts)). It asks only in the cron run
scheduled for the first minute of a UTC day, only after a run whose chain and signer checks passed, and only while the
float is under 20 USDC (the web faucet's claim; the API states no amount); it never retries. Circle documents no rate for the API, so once a day is a
conservative cadence, not a documented one. Without the secret, the Worker only logs `low-inventory`; a manual
`scripts/relayer.ts once` never restocks.

## Known limits

1. Every fill spends the float, which Across testnet never repays. Sends en masse, or a stranger's admitted
   deposits (8 faucet USDC each on Base Sepolia drain 6 here), can empty it; later sends wait at `balance` until a
   top-up, and those past their deadline stay in the source pool.
2. A deposit missed past its deadline, while the Worker is down or its reads keep failing (a provider's outage, or
   its log limits, which a stranger's flood of cheap deposits bound for Sepolia can reach), stays in the source pool.
3. A fill that fails after its approval is retried each minute until its deadline, at an approval and a revoke
   each, and as the largest candidate holds smaller ones back meanwhile.
4. Overlapping runs (a send that outlasts its 25 s budget, or a run stalled past its minute) can waste gas on
   replaced or reverted transactions, and so can a pass whose Sepolia reads hit a backend not yet at the fill the
   pass before it landed. They cannot lose tokens: the pool pulls from the filler only inside the
   filler's own `fillRelay`, once per relay.
5. Eight admitted deposits whose fill reverts even at the gas cap (an intent the router refuses, recovering to a
   fallback receiver that Sepolia USDC blacklists) are refused before any write, but fill a pass's eight tries ahead
   of any send no larger or later than them, until their deadline.
6. Restock is one attempt a day. A float spent just after that minute waits up to a day for a drip, past a send's
   2 h window, so manual top-ups stay; a day whose restock minute's run fails gets no attempt. Circle documents
   neither the API's cooldown nor its amount, so a request inside the cooldown is refused. A duplicated trigger of
   one scheduled time would send a second request. Whether the API funds an address that Circle Wallets did not
   create is unconfirmed until the first drip.
7. A receipt the fill path waits 180 s for without an answer makes it revoke the approval at once, while the
   approval may still be pending: two of the filler's transactions are then out. It costs gas only.

The key is a dedicated one with a small float, never the canary's. Anyone who can deploy to the Cloudflare account
can deploy code that reads the secrets; the loss is the float, and whatever the Circle key may call (step 6 keeps that
to one product).

## The owner's runbook

The agent never holds the key; every step below is the owner's.

1. **Create the key.** The agent files `env-exec request --template
   packages/testnet-relayer/testnet-relayer.env.example --slug relayer-address -- bun
   packages/testnet-relayer/scripts/relayer.ts address`. The owner runs `op-remote create <host> <id>`, which
   generates the key into 1Password, and approves; the run prints the address, never the key. `TESTNET_FILLER` is
   pinned to that address in its own PR. A rotated key repeats this step, the pin and step 2's secret; a send that
   names the old key is filled by `scripts/relayer.ts once` with the old key, from a checkout before the pin moved.
2. **Create the Worker.** In the Cloudflare dashboard, create it from Workers Builds with the settings in
   [`wrangler.jsonc`](wrangler.jsonc)'s header (root directory `packages/testnet-relayer`), and paste the key from
   1Password into the secret `RELAYER_PRIVATE_KEY`. Cron runs need Workers Paid, which allows a run 10,000
   subrequests and 30 s of CPU: a run's four passes make about 260 reads, and the free plan allows 50 and 10 ms.
3. **Fund it** on Sepolia: about 0.02 ETH, and 20 USDC from faucet.circle.com. It needs nothing on Base Sepolia.
4. **Check it.** Send USDC from Base Sepolia in the testnet app and look for `filled` in the Worker's logs.
5. **Run it.** Top up on `low-inventory`. To stop it, remove the cron trigger in the dashboard. While the Worker is
   down, a keyed run of `bun packages/testnet-relayer/scripts/relayer.ts once` on the same template fills one
   deposit per call from the owner's machine, with the same code.
6. **Restock (optional).** Upgrade a Circle developer account for the faucet API (Circle: "requires upgrading to
   mainnet"). Create a Restricted Access key with no permission on any product but the one the drip endpoint needs
   (it sits in the Wallets API reference), in whichever environment, TEST or LIVE, the endpoint accepts (Circle keeps
   them apart; which one is unconfirmed). Store it in 1Password and paste it into the Worker secret
   `CIRCLE_API_KEY`; never give the Worker an entity secret. Read Circle's terms on scheduled claims while upgrading.
   At the next 00:00 UTC run with the float under 20 USDC, the logs show `restock-requested` and the Sepolia USDC
   rises by the drip; `restock-refused` names Circle's code. Delete the secret to turn it off. The manual faucet stays
   the fallback.

A secret that does not derive `TESTNET_FILLER`, as in a rotation half done, makes the Worker refuse every run, and no
run restocks. A send built before the pin moved names the canary, which the Worker ignores (`relayer`): fill it by
hand with `fill-testnet.ts` and the canary key while more than 120 s of its window remain, since it refuses a fill
closer to `fillDeadline`. From then on `fill-testnet.ts` fills the canary's own deposits only.

## Scripts

| Script | What |
|---|---|
| `bun run test` | Unit tests: the route, `classify`, the scan window, a pass over stubbed chains, the passes' schedule, the restock and the Worker's gate on it, the key, the config, and a `wrangler deploy --dry-run` bundle. |
| `bun run test:integration` | `relayOnce` against two anvils at the two chain ids, with the repository's `TestSpokePool` and `MintableERC20` copied to the pinned pool and USDC addresses: a fill and an idle rerun, an ignored deposit, a pass-over and restock, a forged fill, an overlap, the deadline margin. Needs `forge build` in `contracts/bridge/evm`; CI runs it in `_bridge-contracts.yml`. With `RELAYER_LIVE=1`, `test/integration/live-window.integration.test.ts` reads the live testnets instead (keyless, read-only): the window's span by timestamps, a full chunk on each endpoint, Sepolia's fill-log span. |
| `bun run typecheck` | `tsc --noEmit`. |
| `bun run worker:deploy` | `wrangler deploy`: Workers Builds' deploy command, never run by hand. |
