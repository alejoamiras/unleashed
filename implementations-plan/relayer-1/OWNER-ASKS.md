# relayer-1: owner asks

Arc a1 changes nothing a person sees and ships without these answers.

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
