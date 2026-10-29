# relayer-2: owner asks

Nothing a person sees on a screen changes. One question about ask34's guarantees.

## §1 Two cases where ask34's "never" does not hold

ask34 asks that runs never overlap and that the filler never sends a second transaction while one is pending.
a1 makes passes sequential, checks for a pending transaction before every try, and starts no try with under 25 s
left in the minute. Two cases remain. Both come from the fill path in `packages/bridge-core`, which this lane may not
change, and both exist today with one pass a minute:

1. **A send that stalls past the minute.** A send is an approval, then a fill, each awaited until it lands. If the
   send stalls between its approval and its fill (a slow node, a missed Sepolia slot), the next run's first pass sees
   nothing pending and may send its own approval. This is known limit #36. The cost is gas for a replaced or reverted
   transaction; no token moves twice.
2. **A receipt wait that gives up.** The fill path waits up to 180 s for each receipt. When a wait gives up, the fill
   path sends a revoke at once, though the approval may still be pending.

**Options.**
- **A. Accept both as known limits.** This is the ask's cadence with today's risk. Sends now start as late as 33 s
  into a minute, so case 1 has 25 s of slack rather than about 58 s. Case 1 needs a stall at exactly that point.
- **B. Make "never" hold.** Add a lock across runs (a Durable Object), and change the fill path so it waits rather
  than revokes while the approval is pending. This adds persistent state, a coordination protocol and a new recovery
  policy in another package. It is a lane of its own.

**What ships now.** A. a1 ships the passes and states both cases in its PR.

**Recommendation.** A. The cost is gas only and the network is a testnet. B is worth doing only if overlaps show up
in Workers Logs, as two runs whose sends interleave.
