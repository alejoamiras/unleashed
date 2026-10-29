# relayer-1: owner asks

Arc a1 changes nothing a person sees and ships without these answers. #2 and #3 are answered; #1 is open.

## 1. The testnet copy for a Base Sepolia send

**Surface.** Two lines in the testnet app, shown only off mainnet, on a send from Base Sepolia:

- the review step: "Up to 2 h for a manual fill on Ethereum Sepolia, a few minutes for Aztec to pick it up, then
  your claim." (`apps/tools/src/components/send/CrossChainReview.vue`);
- the stepper and the card while the send is on its rail: "Across holds your USDC until a manual fill on Ethereum
  Sepolia. Nothing for you to do; unfilled after 2 h, it is refunded on Base Sepolia." (`apps/tools/src/lib/crosschain-steps.ts`).

**Why it is stale.** Once the relayer runs, nobody fills by hand. Across's docs also say testnet refunds no unfilled
deposit, so the refund sentence is wrong on testnet today, with or without the relayer.

**Options.**

- **A. Keep both lines.** The review still promises a manual fill and a refund.
- **B. Name the relayer, drop the refund.** Review: "Usually a few minutes for our testnet relayer to fill it on
  Ethereum Sepolia, a few minutes for Aztec to pick it up, then your claim." Stepper: "Across holds your USDC until
  our testnet relayer fills it on Ethereum Sepolia. Nothing for you to do."
- **C. As B, and keep a fallback line.** Stepper adds: "If it is not filled within 2 h, it stays in Across's Base
  Sepolia pool: contact us."

**Recommendation.** C: it states what happens, and what happens when the relayer is down, without promising a
refund testnet never makes.

**What ships now.** Neither line changes. A send still completes on its own while the relayer runs.

## 2. Automated USDC restock

**Surface.** None in the app. It decides whether the owner tops up the filler's Sepolia USDC by hand.

**Options.**

- **A. Manual.** The owner claims 20 USDC at faucet.circle.com (once per 2 h per address) when the log says
  `low-inventory`.
- **B. Circle's faucet API.** `POST /v1/faucet/drips` with a Circle API key. Circle says the endpoint "requires
  upgrading to mainnet", and its terms say nothing about scheduled claims. It needs the owner's Circle account, a
  reading of its Service Terms, and a second key in a keyed run.

**Recommendation.** A, until testnet traffic outgrows one faucet's rate.

**What ships now.** A: the service logs `low-inventory` and never claims from any faucet.

**Answer (owner).** Both. Manual faucet claims stay, and a scheduled restock through Circle's faucet API is added:
when Sepolia USDC runs low, the Worker requests a drip at most at the API's documented rate, with the Circle API key
held as a second Worker secret; with no key set the feature is off and the Worker only logs low stock. A new arc after
a1; a1's scope is unchanged. The owner's steps (a Circle account upgraded for the faucet API, the key, the secret) go
in the runbook.

## 3. Workers Paid for the relayer's account

**Surface.** None in the app. It decides whether the Cloudflare account that hosts the relayer runs Workers Paid.

**Why.** A run reads eight log ranges, balances and fill statuses, and a fill sends an approval and a fill and polls
both receipts: tens of subrequests and a few signatures. Workers Free allows 50 subrequests and 10 ms of CPU per cron
run; Workers Paid allows 30 s of CPU and many more subrequests. On Free, a run that fills can be cut off between its
approval and its fill (the next run revokes nothing; the exact allowance stays until a later fill spends it).

**Options.**

- **A. Workers Paid** on the account that already hosts the app and the landing.
- **B. Free.** Runs that only scan fit; runs that fill may stop midway.

**Recommendation.** A.

**What ships now.** The Worker's code and config; nothing deploys until the owner connects it (runbook step 2).

**Answer (owner).** A, Workers Paid: an owner step, kept in the runbook.
