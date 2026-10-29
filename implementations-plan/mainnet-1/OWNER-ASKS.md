# mainnet-1: owner asks

Each entry: the question, the options with what each looks like, a recommendation, and what ships while it is open.
Mockups are sketches of the existing design system (rail on the left, header, content, footer); pictures come from
the orchestrator. Nothing here changes testnet except M6.

## M1. What should the mainnet app show before its gas route is live?

The gas flow needs the mainnet fuel route that you deploy and promote (sdk-1's runbook). Until then the app has no
route to offer.

- **(a) Today's page, unchanged** ("Bridging is being upgraded", its three links, terms-1's Terms and Privacy row).
- **(b) A "Gas opens soon" page.**

```
(a)                                   (b)
┌──────────────────────────────┐      ┌──────────────────────────────┐
│ Bridging is being upgraded   │      │ Gas on Aztec mainnet         │
│ Wallet site · Extension ·    │      │ Opens soon. Buy Fee Juice    │
│ Docs                         │      │ for your Aztec account from  │
│ Terms of Use · Privacy Policy│      │ Ethereum.                    │
└──────────────────────────────┘      │ Testnet app ↗                │
                                      │ Terms of Use · Privacy Policy│
                                      └──────────────────────────────┘
```

- Recommendation: (a). The app switches by itself when your promotion lands, and nothing new needs approving.
- Ships now: (a).

## M2. Which sections does the mainnet app show, and what are they called?

Today testnet shows Bridge, Faucet, Activity and Addresses in the rail.

- **(a) Gas, Activity, Addresses** (Faucet joins after the Drip deploy, M5). The Send section's title becomes "Gas".
- **(b) Gas and Activity only.** Addresses (the contract list) is left out.
- **(c) As (a), but the first section keeps the title "Bridge".**

```
(a)                                         (b)
┌────────┬─────────────────────────────┐    ┌────────┬─────────────────────────────┐
│ ▣ Gas  │ Gas                         │    │ ▣ Gas  │ Gas                         │
│ Activity│ Buy Fee Juice for your     │    │ Activity│ Buy Fee Juice for your     │
│ Addresses│ Aztec account             │    │        │ Aztec account               │
│        │ [wizard]                    │    │        │ [wizard]                    │
│ ◐ theme│                             │    │ ◐ theme│                             │
└────────┴─────────────────────────────┘    └────────┴─────────────────────────────┘
```

- Header subline for Gas, proposed: "From Ethereum · AZTEC or a token swapped to it · public or private".
- Activity on mainnet drops its "Get test tokens" tile until the Faucet exists there. Addresses lists the gas
  route's contracts (router, pause gate, Fee Juice portal, PrivateFPC) and no Drip rows until M5.
- The footer keeps today's mainnet line "Real funds — keep it small" and lists the same contracts as Addresses.
- The Gas section's address: keep `/bridge` (links people already have keep working) or move to `/gas` (with
  `/bridge` sending there).
- Recommendation: (a), and `/gas` with `/bridge` sending there. Addresses is how a careful user checks what they sign
  against.
- Ships now: nothing; a1's screens wait for this answer.

## M3. How does the gas wizard look on mainnet?

On testnet the wizard opens with three cards: Token, Token + gas, Gas. Mainnet has only the gas flow (P1-12).

- **(a) No choice step.** The wizard opens on the token step, titled "Pay with".
- **(b) Keep the three cards**, with Token and Token + gas disabled and a line "Testnet only".

```
(a)                                    (b)
┌───────────────────────────────┐      ┌───────────────────────────────┐
│ Pay with                      │      │ What do you want to send?     │
│ ┌───────────────────────────┐ │      │ [Token]  disabled             │
│ │ AZTEC   Aztec gas         │ │      │ [Token + gas]  disabled       │
│ │ USDC    USD Coin          │ │      │ [Gas]   All of it arrives as  │
│ │ WETH    Wrapped Ether     │ │      │         gas.                  │
│ │ …                         │ │      │ Token sends are testnet only. │
│ └───────────────────────────┘ │      └───────────────────────────────┘
└───────────────────────────────┘
```

The rest is the same in both options, and each point is a choice too:
- Source chain: Ethereum only (no Base, Arbitrum or OP Mainnet; sends from other chains are not built for mainnet).
- Token list: AZTEC first, then the community token list's Ethereum tokens; a token LI.FI cannot swap shows the
  existing "no gas route" message. ETH itself is not offered (the route takes ERC-20 tokens); WETH is.
- Public or private: today's toggle. The Fee Juice always goes to the connected Aztec account; there is no
  recipient field.
- No exit (Aztec to Ethereum) on mainnet.
- Review: today's gas review, with the mainnet warning "Real funds — keep it small".
- Recommendation: (a), and the listed points as written.
- Ships now: nothing; waits for this answer.

## M4. Where do the Terms and Privacy links sit in the mainnet app, and what does the Privacy Policy add?

terms-1 put "Terms of Use · Privacy Policy" under the placeholder's links. The gas app also needs them. The app
will contact four services the Policy must name (a test pins this): dRPC (the Aztec node), PublicNode (Ethereum
reads), LI.FI (swap quotes) and jsDelivr (the token list). The documents describe the mainnet app as a holding page
today; with the gas app live, that text changes, so every user is asked to agree again (terms-1's design).

- **(a) In the footer**, after the contract links: "Terms of Use · Privacy Policy".
- **(b) In the rail**, under the theme control.

```
(a)                                           (b)
┌────────┬──────────────────────────────┐     ┌──────────────┬───────────────────────┐
│ Gas    │ …                            │     │ Gas          │ …                     │
│ …      │──────────────────────────────│     │ …            │                       │
│        │ Router ↗ · Gate ↗ · Portal ↗ │     │ ◐ theme      │                       │
│        │ Real funds — keep it small   │     │ Terms ·      │                       │
│        │ Terms of Use · Privacy Policy│     │ Privacy      │                       │
└────────┴──────────────────────────────┘     └──────────────┴───────────────────────┘
```

- Provider rows, proposed (one per service: who, what it sees): "dRPC — the Aztec node: your IP address and the
  transactions and messages the app reads"; "PublicNode — Ethereum reads: your IP address, your Ethereum address and
  your transaction hashes"; "LI.FI — swap quotes: your IP address, the token, the amount and the router address";
  "jsDelivr — the token list: your IP address and browser headers, no address". The final wording is yours and
  terms-1's drafting rounds.
- The documents' description of the mainnet app (holding page → the gas flow) needs your and your lawyer's update in
  the same change.
- Recommendation: (a), the rows as proposed.
- Ships now: nothing; a1 cannot merge without the Policy rows, because the test that pins them would fail.

## M5. Drip on mainnet: what does "no value" say on each surface?

SIGNAL and NOISE are fixed on chain under those names (changing a name moves the address), so the label lives in the
app. Each mint costs the user real Fee Juice. Every surface of ours that shows the tokens gets a label; the question
is the wording, and what to do with "Add to wallet".

| Surface | Proposed text |
|---|---|
| Faucet header subline | "Play tokens · no real value · each mint costs Fee Juice" |
| Faucet intro (today's dormant mainnet text) | "Play tokens on Aztec mainnet. Connect an Aztec wallet and mint fixed SIGNAL or NOISE into a public or private balance. No real value — each mint pays a small Fee Juice fee from your wallet (buy gas first)." |
| Each token card | today's tag "Test token · no real value" |
| Mint toast | "Dripped 1,000 SIGNAL (no real value) to your public balance" |
| "Added to wallet" toast | "SIGNAL (no real value) added to your wallet." |
| Activity tile | "Get play tokens · SIGNAL · NOISE · no real value" |
| Addresses rows | "SIGNAL (no value)", "NOISE (no value)", "Dripper" |

"Add to wallet" asks the wallet to list the token; the wallet then shows a bare "SIGNAL" balance, with no label we
control. Options: **(a)** keep it on mainnet, with the line "Your wallet will show SIGNAL without this label" beside the
button · **(b)** hide it on mainnet.

```
Faucet, mainnet
┌────────┬──────────────────────────────────────────┐
│ Gas    │ Faucet                                   │
│ ▣Faucet│ Play tokens · no real value · each mint  │
│ Activity│ costs Fee Juice                         │
│        │ ┌ SIGNAL ─────────── [Test token · no ┐  │
│        │ │ public 0 · private 0   real value]  │  │
│        │ │ [Mint 1,000 public] [Mint private]  │  │
│        │ │ (a) [Add SIGNAL to wallet]          │  │
│        │ │     Your wallet will show SIGNAL    │  │
│        │ │     without this label.             │  │
│        │ └─────────────────────────────────────┘  │
└────────┴──────────────────────────────────────────┘
```

- The "Mint AZTEC" card is hidden on mainnet: there is no AZTEC faucet there.
- Recommendation: the texts as proposed, and (b): a bare balance in a wallet is the surface a scam would use.
- Ships now: nothing on mainnet; a3 waits for this answer and for your deploy.

## M6. The links between the two apps

- Placement: **(a)** in the rail, under the theme control · **(b)** in the footer · **(c)** in the header, beside
  the wallets.
- Copy: **(i)** "Mainnet app ↗" on testnet and "Testnet app ↗" on mainnet · **(ii)** "Switch to mainnet" /
  "Switch to testnet".
- Tab: a new tab (the other app keeps its own wallet session) or the same tab.
- Timing for the testnet → mainnet link: **(x)** with a1, while the mainnet hosts still show Cloudflare's login to
  the public · **(y)** a one-line follow-up merged when you open mainnet (P1-09).

```
(a) rail, testnet            (b) footer, testnet
┌──────────────┐             ┌──────────────────────────────────┐
│ Bridge       │             │ Hub ↗ · Factory ↗ · Router ↗     │
│ Faucet       │             │ Mainnet app ↗                    │
│ Activity     │             └──────────────────────────────────┘
│ Addresses    │
│ ◐ theme      │
│ Mainnet app ↗│
└──────────────┘
```

- Recommendation: (a), (i), a new tab, (y).
- Ships now: nothing; a1's link waits for this answer.

## M7. The Drip deploy: how much may it spend, and from which key?

The deployer is a fresh account on the 6.0 rollup. It needs Fee Juice from an L1 deposit of AZTEC to publish two
contract classes and deploy three contracts. No 6.0 mainnet fee for these deploys has been measured. The script prints
each transaction's fee, stops before a send it cannot pay for, and a re-run with more funding resumes it; it never
deposits twice for the same need.

- Budget: a cap per funding, in AZTEC, that you name (recommended: start small and top up), or no cap (not
  recommended).
- Key: **(a)** your pinned mainnet signer (`0xE75e…059c`, the key sdk-1's route deploy also uses), with the cap as a
  code constant · **(b)** a new single-purpose funding key, pinned in code, that you fund with only the budget and the
  ETH for two transactions; its balance is the real ceiling.
- Recommendation: (b). The deploy process loads the whole Aztec client stack; a key that holds only the budget is the
  most a compromised dependency could reach.
- Ships now: a2's script and runbook; no deploy runs. Under (b) you create the key and its 1Password item, and a2's PR
  pins its address.
