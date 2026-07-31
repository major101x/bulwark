# Friction log

Running record of everything confusing, broken, or slower than it should have
been while building on KeeperHub. **Write entries while confused, not after.**
Once something makes sense you cannot reconstruct why it did not.

This feeds the Best Onboarding UX bounty (SPEC.md §12): the worst item becomes a
PR, the rest become a teardown.

## Format

```
### [date] short title
**Doing:** what I was trying to accomplish
**Expected:** what I thought would happen
**Got:** what actually happened
**Cost:** how long I lost
**Fix:** what would have prevented this
```

---

### 2026-07-30 Repo scaffolded before account exists

**Doing:** Setting up the project skeleton ahead of signing up.
**Expected:** n/a, baseline entry.
**Got:** Wrote the KeeperHub REST client against the published docs without
being able to verify request or response shapes, because the API reference does
not show a full example payload for `execute` or the execution status poll.
**Cost:** ~0 so far, but every field name in `agent/executor.ts` is a guess and
carries a `TO VERIFY` marker.
**Fix:** A single copy-pasteable curl example per endpoint, showing a real
request and a real response body, would remove the guesswork entirely. This is a
strong bounty candidate.

---

### 2026-07-30 Docs do not state free-tier execution quota

**Doing:** Sizing the block-interval trigger for `hf-watch`.
**Expected:** A quota number on the pricing or quickstart page.
**Got:** Quickstart does not mention free-tier limits or gas sponsorship terms;
the marketplace page mentions quota only obliquely, via the note that executions
priced at $0.05+ do not count toward it.
**Cost:** Blocked on choosing a poll interval; had to design the tier system to
be quota-adaptive as a hedge.
**Fix:** State the quota on the quickstart page. A keeper's poll interval is one
of the first decisions a builder makes and it depends entirely on this number.

---

### 2026-07-31 "Fund your wallet" reads as complete, but only covers gas

**Doing:** Working out what the KeeperHub wallet needs before it can execute a
rescue.
**Expected:** The quickstart says to fund the wallet with ETH on Mainnet or
Sepolia. I read that as the wallet being funded, full stop.
**Got:** ETH only covers gas. It is burned to pay for transactions and is not
available to the actions themselves. A keeper that repays a USDC debt has to be
holding USDC, and nothing in the setup flow says so. A wallet funded exactly as
the quickstart describes will execute a workflow that reverts for insufficient
funds, or in our case is correctly refused up front and logs `no feasible
remedy`, which looks like a bug in your own agent rather than a funding gap.
**Cost:** Would have been an hour of confusion at the first live rescue, caught
only because a beginner asked why test tokens were needed if the wallet already
had ETH.
**Fix:** Split the funding step in the quickstart into two: "gas, so the wallet
can transact" and "assets, so the wallet has something to transact *with*". One
sentence would do it. The distinction is obvious once you know it and invisible
before.

---

### 2026-07-31 The managed wallet cannot be connected to any dapp UI

**Doing:** Getting Aave test tokens into the KeeperHub wallet so the keeper has
something to rescue with.
**Expected:** Connect the KeeperHub wallet to the Aave faucet and claim, the way
you would with any wallet.
**Got:** Not possible, and reasonably so. The wallet lives in a Turnkey enclave
with no browser extension and no WalletConnect surface, which is exactly the
security property that makes it attractive. But it means the only way to give
the wallet an initial token balance is to claim with a browser wallet elsewhere
and transfer in. That bootstrapping step is not mentioned anywhere in the docs,
and it is a prerequisite for any workflow that spends tokens rather than just
reading state.
**Cost:** ~30 minutes of looking for a connect button that does not exist.
**Fix:** Two options, both cheap. Either document the transfer-in step wherever
wallet funding is described, or add a "receive" panel next to the wallet address
in the UI that spells out that tokens must be sent from another address. The
docs currently describe the wallet as the thing that executes, and never as a
thing that needs stocking first.

**Bounty candidate:** yes, strongest so far. It affects every builder whose
workflow spends a token, which is most of them.

---

### 2026-07-31 Both hosted Aave testnet faucets were down

**Doing:** Getting Sepolia test tokens to open the position.
**Expected:** Click through gho.aave.com/faucet, as the Aave docs describe.
**Got:** The faucet page did not work, and neither did the bridge button on
app.aave.com, which now defaults to Base. Ended up calling the Sepolia faucet
contract at 0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D directly with a script.
**Cost:** ~45 minutes, and it is a hard stop for anyone who cannot write a
minting script.
**Fix:** Not KeeperHub's bug, but it is squarely in KeeperHub's onboarding path,
since every Aave-based tutorial starts here. A short "if the faucet is down,
mint directly" snippet with the contract address in the KeeperHub docs would
unblock people. Our `starter-template/` should ship this script.

---

### 2026-07-31 You cannot borrow a position into liquidation

**Doing:** Driving the test position to a critical health factor to trigger the
agent on camera.
**Expected:** Borrow more against the same collateral until HF approaches 1.0.
**Got:** Aave reverts with `execution reverted: "36"`, a bare number with no
explanation. Decoded, that is COLLATERAL_CANNOT_COVER_NEW_BORROW. Borrowing is
validated against the collateral's LTV (70%) while liquidation is measured
against the liquidation threshold (75%), so borrowing bottoms out at
LT / LTV = 1.0714 and cannot go lower. Withdrawing collateral is validated
against HF >= 1 instead, and reaches any target above 1.0.
**Cost:** ~30 minutes, most of it decoding "36".
**Fix:** Two things. Aave's numeric revert codes are opaque and worth mapping in
any tooling that wraps them, which we now do in `scripts/lib.ts`. More usefully
for KeeperHub: a "how to drive a test position into danger" recipe would save
every builder attempting a liquidation-adjacent demo the same 30 minutes, and
liquidation defense is an obvious thing to build on an execution layer.

---

### 2026-07-31 search_protocol_actions returns nothing when protocol and query are combined

**Doing:** Discovering the Aave action schemas through the MCP server.
**Expected:** `{protocol: "aave-v3", query: "supply borrow repay health factor"}`
to return the Aave actions, since the tool description gives 'aave-v3' as an
example protocol value.
**Got:** Zero results. The same call with `protocol` alone returns all 7 actions,
and `query: "aave"` alone returns 16. The multi-word query appears to require
every term to match, so combining a valid filter with a natural-language query
silently returns nothing.
**Cost:** ~5 minutes, but the failure mode is "this protocol is unsupported",
which could send someone down a much longer detour.
**Fix:** Either OR the query terms, or return a hint when a filter matches
records but the query eliminates all of them. An empty result that means "your
query was too specific" should not look identical to "not supported".

---

<!-- Add entries below as they happen. Do not batch them up. -->
