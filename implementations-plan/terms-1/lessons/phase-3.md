# Phase 3: the Terms of Use

## Claim → code (traced before the drafting rounds)

| Claim (section) | Code |
|---|---|
| The mainnet app is a holding page today (3) | `apps/tools/src/App.vue` mounts only `MainnetPlaceholderView` on the mainnet build; its CSP `connect-src` is `'self' data: blob:` (`MAINNET_TARGET`, `apps/tools/src/lib/network-targets.ts`) |
| The gas flow: deposit, swap into Fee Juice unless it already is, Fee Juice portal for the user's Aztec account (3) | `DepositRouter.bridgeWithPermit` (`contracts/bridge/evm/src/DepositRouter.sol:134`): fuel-only needs `fuelSlice == amount` (`:141`); `_settle` swaps through `SWAP_TARGET` unless `token == FEE_ASSET` (`:271-276`), then `FeeJuicePortal.depositToAztecPublic(fuelRecipient, …)` (`:278-284`). Funds come only from `msg.sender` (`:22`) |
| Pause stops new deposits; a deposit already in the portal is unaffected (5) | `PortalFactory.setPaused` (`PortalFactory.sol:62`, `onlyOwner`); the router checks `FACTORY.depositsPaused()` on every leg (`DepositRouter.sol:29,235`). Claims on Aztec read the portal's message, not the factory |
| Sweep reaches only balances held outside a call (5) | `DepositRouter.sweep` (`:191`, `onlyOwner`, `nonReentrant`); accounting by deltas (`:24-25`) |
| No key we hold moves Fee Juice in the portal; the PrivateFPC has no owner (5) | FeeJuicePortal is Aztec's protocol contract (`IFeeJuicePortal`); the PrivateFPC artifact exposes `balance_of`, `mint`, `mint_and_pay_fee`, `pay_fee`, `recurse_subtract_balance_internal` (only-self), `offchain_receive`, `sync_state`, `public_dispatch`: no owner or admin function (`@alejoamiras/private-fee-juice` `target/private_contract-PrivateFPC.json`) |
| Claim material lives only in the browser (6, 7) | `packages/bridge-core/src/journal.ts` (recon F6) |
| Apache 2.0 (10) | root `package.json` `license` |

## Drafting rounds

**Round 1** (gpt-6.1-sol, max, fresh session): 10 material objections. Each was checked against the
tree before it was applied.

| # | Objection | Disposition |
|---|---|---|
| 1 | Acceptance by mere use is browsewrap (*Berman*, 9th Cir. 2022) | accepted: acceptance is the signed message naming the version (C4); visiting is not acceptance |
| 2 | "Not a financial service" and the role list are legal conclusions | accepted: "we do not act as your custodian, broker, exchange, bank or adviser"; "money transmitter" dropped |
| 3 | "Never hold or control your funds" ignores `sweep` (`DepositRouter.sol:191`); finality is at confirmation (`journal.ts:280`) | demonstrated, accepted: keys and deposits never held; tokens sent outside a deposit point to §5; final once confirmed |
| 4 | Private gas lands at the PrivateFPC, which takes the whole fee allowance with no refund (`fuel-target.ts:14`, `private-fuel.ts:179`) | demonstrated, accepted: a "Private gas" risk |
| 5 | Name gross negligence and consumer service rights in the carve-out | rejected (minor): "anything else the law does not allow us to exclude" already covers it; naming gross negligence would concede it where the law allows excluding it |
| 6 | Indemnity covers any loss, including ones we caused (CRA 2015 Sch. 2 para 6) | accepted: third-party claims from the user's breach, never losses we caused |
| 7 | The release reaches accrued and non-excludable claims (Cal. Civ. Code §1668; 93/13/EEC) | partly: the release keeps the §1542 waiver but covers only losses from the accepted risks, excludes what §12 keeps, and re-acceptance releases nothing already accrued. Dropping it, as proposed, would remove a protection the owner was told about (C1 line 10) |
| 8 | Change or end "at any time without notice" (CRA Sch. 2 paras 8, 11, 13) | accepted: reasons named; notice on unleashed.systems where possible so claims can finish; a new version applies after acceptance |
| 9 | The representative-action ban reaches public injunctive relief (*McGill v. Citibank*, Cal. 2017); the £5,000 floor (Arbitration Act 1996 ss. 89–91, SI 1999/2167) | accepted |
| 10 | Unrestricted assignment (93/13/EEC Annex 1(p)) | accepted: only without reducing the user's rights; no prior notice, as the operator holds no user contact |
| 11 | "Limited … to the smallest extent" invites rewriting (C-618/10) | accepted: the invalid part does not apply |

Residuals added to plan.md: the E-Commerce Regulations 2002 reg. 6 identity duty under A1/A2; the
mainnet PrivateFPC is a frozen 5.0.1 artifact (`private-fpc-canonical-mainnet.json`) this tree cannot
inspect, so "has no owner" is re-traced at promotion (runbook line).

**Round 2** (resumed): 1 material objection. "Once confirmed, it is final" is false: the deposit path
accepts a successful receipt (`send-flow.ts:325`) and a reorg can undo an included block before
finality (`journal.ts:280` names the finalized head). Accepted: inclusion is not finality.

**Round 3** (resumed), the closing verdict, quoted: "No objections. The fix at terms.ts:67 correctly
distinguishes block inclusion from finality. Confidence: high. … VERDICT: no material objection". Its
residuals repeat the ones in plan.md.
