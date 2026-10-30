# Owner asks: sdk-reads-1

## ask-1: an Ethereum balance read that cannot be made or decoded

**What ships now, without this answer.** A balance read the RPC refuses (rate limit, server error, timeout, any
JSON-RPC error) rejects in the SDK as it already does in the app. The app looks the same as today in every case.

**The question.** Two more cases read as zero balances today, though no balance was read:
- the read RPC answers the balance call with no data or bytes that do not decode: `0x` (a node with no Multicall3 code
  where the chain declares it), `null`, or cut short;
- the wallet hands the app an account address with a wrong checksum, which viem cannot encode into the call.

Today the app shows every token as `0` then, and the amount step refuses every amount. Should both look like a
refused read instead?

**Surface.** Send screen: the token rows, and the balance under the amount field.

| | Today (ships now) | Recommended |
|---|---|---|
| Rows already read | change to `0` | keep the balance already read |
| Rows not read yet | `0` | `—` |
| Amount step | balance `0`; every amount refused | balance unknown; the amount is not refused for the balance |

```
Today                         Recommended
┌──────────────────────────┐  ┌──────────────────────────┐
│ USDC  USD Coin         0 │  │ USDC  USD Coin    12.50  │  (kept from the last read)
│ WETH  Wrapped Ether    0 │  │ WETH  Wrapped Ether    — │  (never read)
└──────────────────────────┘  └──────────────────────────┘
```

**Recommendation.** Treat both as a refused read. It is the behaviour already approved for refused reads (balances-1:
"a refused call keeps the figures already read instead of showing zeros"). It needs no new copy.

**Cost of yes.** A follow-up PR with two SDK lines and two tests: a failure counts as the token's own only when viem
names it after `balanceOf` (an aggregate answered `0x` rejects), and an owner that fails viem's address check rejects.
