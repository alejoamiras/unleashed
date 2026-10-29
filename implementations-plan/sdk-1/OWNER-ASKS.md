# sdk-1: owner asks

Every arc after a1 waits for §1 and §2. a1 (the mainnet fuel route: a pause gate contract, the manifest block, the
deploy and verify tooling, the runbook) needs none of these answers and ships first. Nothing here changes a screen.

## §1 The SDK's public interface (ask5)

**What ships now.** Nothing of the interface. a1 ships; a2–a5 wait for this answer.

**Recommendation.** The SDK takes the caller's wallets (an Aztec wallet from `@aztec-labs/wallet-sdk`, a viem wallet
client for Ethereum), uses plain promises, awaits the caller's storage before every irreversible step, and reports
typed, ordered events. Two entry points: **fuel** (the fee asset or any priced token, into the Fee Juice portal as
public or private Fee Juice) and **bridge** (a token, or a token plus gas, through the hub).

```ts
// "@unleashed/sdk" (name: §2)
export function parseNetwork(manifest: unknown, r: Reads): Promise<Network>
  // strict; re-derives addresses; refuses a non-canonical Permit2, a Fee Juice portal or registry the Aztec node does
  // not report, a router or factory whose code is not the pinned build, token portals bound to another rollup's
  // Inbox or Outbox, a slippage above 3 %, a line the SDK does not run
export interface Network { readonly l1ChainId: number; readonly walletChainId: number
  readonly fuel: FuelRoute; readonly bridge?: TokenRoute }           // bridge absent on a fuel-only network
export interface Reads { l1: PublicClient; aztecNode: AztecNode; fetch?: typeof fetch } // li.quest is keyless
export type Privacy = "public" | "private"

export interface RunOptions {
  /** Awaited before the first wallet prompt, then before each event that names a new fact. A rejection before the
   *  signature aborts with nothing signed. Store `secrets` sealed; they are never in a record or an event. */
  persist(record: DepositRecord, secrets?: { claimSalt?: Fr; fuelSalt?: Fr }): Promise<void>
  onEvent?(e: TransferEvent): void          // display only; a throw here never changes the run
  signal?: AbortSignal                      // stops waiting; never cancels a sent transaction
}

// "@unleashed/sdk/fuel": does not load the 3 MB hub artifact
export function probeFuel(net: Network, r: Reads, token: Address, probeIn: bigint): Promise<FuelRate> // sizing, no floor
export function quoteFuel(net: Network, r: Reads,
  q: { token: Address; amount: bigint; recipient: AztecAddress; privacy: Privacy }): Promise<FuelQuote>
export function depositFuel(net: Network, r: Reads, l1: WalletClient, quote: FuelQuote, run: RunOptions): Promise<DepositRecord>
export function claimFuel(net: Network, r: Reads, aztec: { wallet: Wallet; account: AztecAddress },
  rec: DepositRecord, run: RunOptions & { secrets?: { fuelSalt?: Fr } }): Promise<ClaimOutcome>

// "@unleashed/sdk/bridge"
export function resolveToken(net: Network, r: Reads, erc20: Address): Promise<BridgeToken>
  // portal, name/symbol words, decimals, derived L2 address; any ERC-20, listed or not
export function quoteBridge(net: Network, r: Reads, q: { token: BridgeToken; amount: bigint; recipient: AztecAddress;
  privacy: Privacy; gas?: { txTarget: number } }): Promise<BridgeQuote>
export function depositToken(net: Network, r: Reads, l1: WalletClient, quote: BridgeQuote, run: RunOptions): Promise<DepositRecord>
export function claimToken(net: Network, r: Reads, aztec: { wallet: Wallet; account: AztecAddress },
  rec: DepositRecord, run: RunOptions & { secrets?: { claimSalt?: Fr; fuelSalt?: Fr } }): Promise<ClaimOutcome>
export function capabilitiesFor(net: Network, need: { fuel?: true; tokens?: BridgeToken[] }): AppCapabilities
  // exact addresses only (a chosen token's L2 address included); merge into your wallet request

export type TransferEvent = { id: Hex; seq: number } & (      // seq strictly increases within one call
  | { type: "prepared" }                                       // record and secrets stored
  | { type: "approval"; status: "sent" | "confirmed"; txHash: Hex }   // only when the Permit2 allowance is short
  | { type: "signature-requested" }
  | { type: "deposit-sent"; txHash: Hex }
  | { type: "deposit-confirmed"; leaves: Leaves }
  | { type: "arrival"; stage: "counting" | "unfolded" | "wallet-sync"; blocksLeft?: number; checkpointsLeft?: number }
  | { type: "claimable" }
  | { type: "registration-sent"; txHash: string }             // a private first claim of a token
  | { type: "claim-sent"; txHash: string; payer: "fuel" | "fpc-credit" | "own-gas" }
  | { type: "claim-proposed"; txHash: string }                // display only, not settlement
  | { type: "settled"; via: "claim" | "claimed-elsewhere"; txHash?: string })

export class BridgeError extends Error {
  readonly code: "wrong-chain" | "wrong-aztec-network" | "unsupported-line" | "user-rejected" | "persist-failed"
    | "no-fuel-route" | "quote-moved" | "below-floor" | "paused" | "deposit-reverted" | "receipt-mismatch"
    | "message-timeout" | "message-invalid" | "fee-stop" | "registration-dropped" | "registration-reverted"
    | "claim-not-visible" | "claim-reverted" | "receipt-timeout"
  readonly submission: "none" | "submitted" | "unknown"     // did anything reach a chain for this transfer?
  readonly retry: "safe" | "after-wait" | "never"
}
```

```ts
// A gas-only deposit, end to end
const net = await parseNetwork(manifestJson, reads)
const quote = await quoteFuel(net, reads, { token: USDC, amount: 25_000_000n, recipient, privacy: "private" })
const rec = await depositFuel(net, reads, walletClient, quote, { persist: store.save, onEvent: render })
const done = await claimFuel(net, reads, { wallet, account: recipient }, rec,
  { persist: store.save, onEvent: render, secrets: await store.secretsOf(rec.id) })
```

**The options the panel weighed, and why this one.**

| Question | Option A (recommended) | Option B | Why A |
|---|---|---|---|
| Inputs | The SDK takes the wallets | It returns unsigned transactions for you to submit | A claim is not one transaction: whether it registers is decided at claim time, a private first claim is two transactions with a wait between them, and the fee choice reads the wallet. Unsigned data would hand every integrator the steps that strand funds when done wrong. A Safe or smart account still works through an EIP-1193 adapter; the low-level builders stay available in `@unleashed/sdk/protocol`. |
| Style | Plain promises | Effect 4 | Integrators and the Vue app use promises; Effect would add a second surface. Aztec proving cannot be interrupted. Effect 4 is a new major release. |
| Shape | Free functions per entry point | One `createBridge()` object | A gas-only app loads no hub artifact; nothing holds a signer longer than one call. |
| Failures | Throw `BridgeError` with `submission` and `retry` | Return `Result` values | Same information, less unwrapping. |

**Bundled networks (yes or no).** `@unleashed/sdk/networks` could ship the promoted testnet and mainnet manifests, so an
integrator needs no file from our hosts. This is also a security choice: the checks above read the chain through the
integrator's RPC, so a manifest from a bundled, reviewed release is the strongest root an integrator can have. Cost: a
testnet reset then needs an SDK release (an Aztec line bump already does). Recommendation: yes.

**What we need from you.** Approve, or name the changes.

## §2 The npm package name

**What ships now.** The workspace is `packages/sdk`, named `@unleashed/sdk` inside the repository until you pick.

Candidates: `@unleashed/sdk` (needs the `@unleashed` npm organization; its owner is unverified, and no package exists
under it), `@unleashed-systems/sdk`, `@alejoamiras/unleashed`. A name outside `@unleashed/` also changes the root
workspace filter (`--filter '@unleashed/*'`) and `scripts/ci-cd/workspaces.test.ts`. Recommendation: `@unleashed/sdk`
if you own or can create the organization.

## §3 Mainnet runs another Aztec line

**What ships now.** a1's fuel route is built, with its mainnet fork test written; the owner's keyed run executes that
test before any promotion, and nothing is deployed. The SDK refuses every mainnet deposit and claim with
`unsupported-line` until the mainnet node runs the SDK's line.

Mainnet runs Alpha 5.0.1; this repository and the SDK are on 6.0.0 (`MAINNET_ROLLUP_VERSION`, the mainnet PrivateFPC
descriptor at 5.0.1). The Ethereum half of a fuel deposit works on either line; the Aztec claim from a 6.0.0 client
against a 5.0.1 node is unproven. Options:

- **A (recommended):** wait for Alpha to reach the SDK's line; the SDK refuses mainnet deposits and claims until
  then, before any wallet prompt; the route's deploy and promotion wait too.
- **B:** let the SDK make public mainnet fuel deposits now, leaving the claim to the user's own wallet. Funds stay
  claimable by the recipient, but our flow would stop halfway.
- **C:** fund support for the older line in the SDK (a second set of artifacts and payment methods).

## §4 SDK v1 scope

**What ships now.** v1 has ask5's flows: fuel (identity and swap, public and private) and bridge (token, token plus
gas). Exits, the cross-chain source leg (sends from Base and other chains), Drip and the AZTEC mint stay on private
code; the app keeps them unchanged. Cross-chain claims already run on the SDK. Recommendation: keep v1 to ask5's
flows; add exits and cross-chain sends in a later version if integrators ask.

## §5 Who owns the mainnet pause gate

**What ships now.** The gate takes its owner as a constructor argument; nothing is deployed.

The gate is the switch that pauses every mainnet fuel deposit. Options: the pinned mainnet signer that `live-intent`
already names (`0xE75e…059c`), or a multisig. Recommendation: a multisig, since the switch guards live funds.

## §6 The first npm publish

**What ships now.** a5 ships the publish workflow (two jobs; the publish job alone holds the OIDC token) and runs
nothing.

npm's trusted publishing is configured on a package that already exists, so the first version needs another
credential. Options: **A (recommended)** you publish the first version from your own machine with npm's two-factor
prompt (no stored token), then name the workflow and its `npm-publish` environment as the trusted publisher; **B** a
short-lived granular token, used once and deleted. Either way, every later version goes through the workflow with
provenance.

## §7 The mainnet guardian the SDK pins

**What ships now.** `parseNetwork` holds mainnet's factory, router and gate to this release's code, not to their
owner. A manifest naming a genuine-code generation that someone else deployed passes, and its guardian can pause it: a
delay, never a transfer.

Options: **A (recommended)** pin the guardian address once the mainnet generation exists (the factory's and the gate's
`owner()`, the hub's L2 guardian) and ship it in an SDK release; moving the guardian later, to a multisig say, then
needs a release first. **B** leave it unpinned and rely on integrators shipping the bundled manifest.

**Decided:** A.

## §8 Refuse a paused route before any prompt

**What ships now.** A send on a paused route goes as it does today: the wallet asks for the approval and the
signature, and the router's revert ends the send with nothing moved.

The SDK can read the pause switches first and refuse before any prompt; the app keeps that check off, because the
refusal would be a new sentence on the review. Options: **A (recommended)** turn it on, with copy such as "Deposits
on this route are paused right now. Nothing was sent."; **B** keep today's path.

## §9 Two failures that read differently

**What ships now.** The send checks the network against the chain before its first prompt (the SDK's trust check, the
plan's D40). A correctly deployed network never shows either difference:

- A node that does not answer, or contracts the bundled network does not name, stop the send before any prompt. Before,
  the deposit went out and its claim waited on the node. The review shows the node client's error, or for a mismatch
  the SDK's own sentence ("the deployed contracts are not this release's network: …"). The first send of a page also
  waits on the check, about a second.
- A wallet that leaves the chain between a send's start and its signature now stops before the signature. A public
  send's row is discarded and the review names the wrong chain, as it does when the chain is wrong at the start;
  before, the signature went out and the row stayed, flagged.

Options: **A (recommended)** keep both, and give the first this app's own sentence: "This app could not check the
bridge on this network. Nothing was sent."; **B** keep both as they read now.

## §10 The app's claims on the SDK's claim behaviour

**What ships now.** The app claims exactly as today. Its claim engine already runs on the SDK's building blocks (the
fee choice, the arrival checks, the hub claim, the deposit search), but it keeps its own order of steps, and the
SDK's `claimToken`/`claimFuel` order them differently in ways a person would notice. a4 ships two SDK fixes for
integrators (bridged gas its own claims could leave unclaimed) and leaves the app's claim engine as it is until you
choose.

If the app ran its claims through the SDK's entries, a person would notice:

1. A claim that cannot pay its fee says so as soon as the claim starts, instead of after the crossing finishes.
2. A token someone else claimed first: the app claims your bridged gas on its own (one wallet prompt, when the gas
   is still unclaimed and can pay for its own claim), public or private, instead of leaving the card open with "press
   Claim your gas" or "keep it".
3. Gas left over when a claim paid from gas you already held: claimed after the token claim lands, not right after it
   is sent; if that gas claim fails for a while, the card stays open with the error instead of completing.
4. A claim the network dropped while you were away is sent again (a wallet prompt) instead of the card saying "The
   claim was dropped — claim again from this card."
5. Fewer progress lines: no "verifying" step for a claim found on reload, no "node unreachable — retrying", a
   crossing count that can stop one short of full or rise again during one wait, and a retry shows the crossing again
   for a moment.
6. A deposit found after a reload waits up to about 12 minutes for its Ethereum confirmation instead of saying
   "retry in a minute".
7. A claim interrupted while your wallet prompt was open waits up to 15 minutes ("an earlier claim may still land")
   instead of asking again, which avoids paying a second fee.
8. Before the first claim prompt the app checks the bridge and the wallet's network, with the sentences of decision
   page 7 (P7-02).

Options: **A (recommended)** run the app's claims through the SDK and accept 1–8, with two things the SDK gains for
every integrator first: a resume that only watches and never prompts (the app resumes on page load), and the "claim
without gas" choice the card offers today. **B** keep today's behaviour and teach the SDK the app's ways as
app-only switches: about seven of them inside the code that protects funds. **C** keep the app's engine as it is.
