## Outcome

Archived. Seeds retired.

# Send wizard UX redesign

Tier: light (owner-directed, single app, no protocol change). Follow-up arc of
[any-erc20-bridge](../any-erc20-bridge/plan.md) — the P10 testnet walk produced the feedback this
plan answers. Design canvas approved by the owner ("I have no feedback. Implement.");
the mint showcase was re-decided to variant B in the same session.

## Goal

The Send tab reads as one three-step flow in the app's visual language, with no wallet-seam or
bridge-engine change: everything below `apps/tools/src/composables/**` and `packages/bridge-core`
keeps its contract, except one read that today runs only once the Aztec wallet is connected.

## Scope

1. **Step strip** → numbered stepper: filled active step, check + chosen value for done steps, dim
   todo steps, connector rule, caption `Step N of 3 — …`.
2. **Token step**: one search field that also accepts an Ethereum address; an address shows a
   lookup result row (`SYMBOL · name · N decimals`, short address) with ADD, then the row joins the
   list marked `added by you`. Provenance chips and the provenance line are gone. The
   "First time for this token" state label is gone. Footer: `Sending X · balance on Ethereum N`
   plus an accent CONTINUE.
3. **Mint (variant B)**: a testnet-only dashed strip above the list — `TESTNET  Free test tokens:`
   followed by one `+100 SYMBOL` button per `permissionless-mint` manifest token. Mainnet renders
   nothing there; the rest of the step is identical on both networks. `MintTestToken` leaves the
   wizard.
4. **Amount step**: the three choice cards become a segmented control; MAX becomes a `Use all`
   text link beside the balance; the gas card becomes `Gas for [− N +] transactions` with
   `Arrives as X` / `Arrives as gas ≈ Y FJ from Z` and a `How the gas is sized` disclosure;
   gas-only shows `Arrives as gas` + `Enough for ≈ N transactions` and nothing else.
5. **Review step**: Arrives lists both legs; Fee reads `≈ X FJ — the first of those N, paid from
   that gas` (token-only: `paid from the gas you already hold on Aztec`); Details is a bordered row with a chevron.
6. **First-time false positive**: the hub binding is read from the node's public storage (the
   `token_of` map slot the hub artifact declares), whether or not an Aztec account is connected,
   so a registered token never shows the register path on a plain wallet.
7. **Run in background** returns the wizard to step 1 with a slim status strip above it, instead
   of leaving step 3 populated with the finished send.
8. **Token-only sends**: the claim self-pays from Fee Juice the account already holds — there is no
   sponsor on any network (`gateNoFuelClaim` stops with "No gas" otherwise) — so the recipient's
   public and private Fee Juice are read on the Amount step and two known zeros steer to
   `token + gas`; the review's fee line says where the fee comes from.

Out of scope: the exit (Aztec → Ethereum) form beyond the shared stepper; the Drip tab; any
change to the wallet.

## Validation

`bun run --cwd apps/tools typecheck`, `bun run --cwd apps/tools test` (component + jsdom smokes),
`bun run lint`, `bun run --cwd apps/tools build` against the promoted testnet manifest, then the
preview walk by the owner (the wallet-seam checklist in
[phase-10 lessons](../any-erc20-bridge/lessons/phase-10.md)).

## Delivery

One PR on top of the any-erc20-bridge stack, squash-merged after the
stack lands. `/code-review medium --fix`, then the codex fix loop until "no new material findings".

## Security & adversarial considerations

- The address lookup reads `name/symbol/decimals` from an arbitrary ERC-20 the user typed. Every
  field is rendered as text (never HTML), symbol/name are length-clamped, and the row shows the
  short address so a look-alike symbol cannot impersonate a listed token.
- Mint buttons only render for tokens the signed manifest marks `permissionless-mint`; the amount
  is fixed client-side and the call is the token's own `mint(to, amount)` — no new contract
  surface.
- The no-gas gate is advisory UX over a balance read; the claim's own gate re-reads and fails closed.
