# Friction log

Running record of everything confusing, broken, or slower than it should have
been while building on KeeperHub. **Write entries while confused, not after.**
Once something makes sense you cannot reconstruct why it did not.

This feeds the Best Onboarding UX bounty: the worst item becomes a
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

### 2026-08-02 web3/* actions are discoverable but not directly executable

**Doing:** Approving LINK to the Aave pool so the keeper could supply collateral.
**Expected:** `web3/approve-token` is listed by `list_action_schemas` with a full
parameter spec, so calling it via `execute_protocol_action` should work.
**Got:** `501 Not Implemented: Direct execution not supported for
"web3/approve-token". Use workflow execution instead.` The hint is good and the
workaround (`execute_contract_call`) is fine, but nothing in the schema listing
distinguishes actions that can be executed directly from those that cannot.
**Cost:** ~10 minutes.
**Fix:** Add a `directExecution: true|false` flag to the action schema output.
Agents choose tools by reading that listing, and there is currently no way to
know which half of it is callable without trying.

---

### 2026-08-02 aave-v3 amounts are in base units, but only aave-v4 says so

**Doing:** Supplying 6.34 LINK as collateral.
**Expected:** Human units, since `web3/approve-token` documents its amount as
"100.50 or max".
**Got:** `invalid BigNumberish string: Cannot convert 6.34 to a BigInt`. The
aave-v3 actions take smallest units. The aave-v4 descriptions state this
explicitly ("wei for 18-decimal tokens"); the v3 ones do not, and the adjacent
web3 action uses the opposite convention.
**Cost:** ~10 minutes, and it fails loudly, which is lucky. Passing a human
amount where base units are expected would silently supply dust if the string
happened to parse.
**Fix:** State the unit in every amount field description, and ideally use one
convention across web3 and protocol actions. Mixed conventions inside one tool
surface are a foot-gun for agents, which cannot see the inconsistency.

---

### 2026-08-02 referralCode is required but advertised as optional

**Doing:** Calling `aave-v3/supply`.
**Expected:** Omitting an optional field is fine.
**Got:** `Invalid function arguments: referralCode: uint16 is missing`.
`search_protocol_actions` lists `referralCode` under `optionalFields`, but the
ABI encoder requires it. The same likely applies to `interestRateMode` on
borrow and repay.
**Cost:** ~5 minutes.
**Fix:** Either default it to 0 server-side, or move it to `requiredFields`.
An agent that trusts the schema will fail its first write.

---

### 2026-08-02 Sepolia executions are gas sponsored, which the docs do not mention

**Doing:** Budgeting Sepolia ETH for the keeper wallet.
**Expected:** Sponsorship on mainnet only, per the hackathon brief and Discord.
**Got:** Both executions returned `sponsored: true` on Sepolia, and the keeper
wallet's ETH balance did not move. Also learned the wallet is an EIP-7702
delegated EOA: calls route through an executor contract, but `msg.sender`
remains the wallet, so allowances and balances behave normally.
**Cost:** None, a pleasant surprise, but we funded the keeper with testnet ETH
that turned out to be unnecessary.
**Fix:** Say which networks are sponsored on the wallet page. This is a nice
feature that is currently invisible, and it removes a whole faucet step from
onboarding.

---

### 2026-08-02 Condition compares a string against a number, and the quoting is load-bearing

**Doing:** Building the health-factor threshold check in a Condition node.
**Expected:** A numeric comparison.
**Got:** It works, but the execution log shows
`resolvedExpression: "\"1300354189147293759\" < 1050000000000000000"`. The left
operand stays a quoted string (contract reads return strings) while the right
becomes a bare number literal, so JavaScript coerces numerically and the answer
is right. That correctness depends entirely on the right operand being emitted
unquoted. Had both sides been strings, the comparison would be lexicographic,
and a health factor below 1.0 (18 digits) would compare as GREATER than a 19
digit threshold, reporting a liquidatable position as safe. For a liquidation
keeper that is the worst possible silent failure.
**Cost:** ~15 minutes of reading the trace carefully instead of trusting a
passing test.
**Fix:** Coerce both operands explicitly when the rule operator is numeric
(`<`, `<=`, `>`, `>=`), or surface the resolved types in the log. Contract reads
return uint256 as strings, so numeric comparison against on-chain values is
going to be extremely common, and right now it works by a quoting coincidence
that is invisible unless you read `resolvedExpression`.

**Bounty candidate:** yes. Silent wrong-branch evaluation on 18-decimal values
would affect any threshold workflow over a token amount or health factor.

---

### 2026-08-02 get_execution includeData:false still returns the whole workflow

**Doing:** Polling a running execution for node status.
**Expected:** `includeData: false` to give the "compact status-only response"
the tool description promises.
**Got:** Node input/output blobs are stripped, but every response still embeds
the complete workflow definition (all nodes, configs, edges) inside
`logs.execution.workflow`. For a six-node workflow that is most of the payload,
and it repeats on every poll.
**Cost:** No lost time, but it makes polling expensive for an agent paying by
the token, which is exactly who uses MCP.
**Fix:** Have `includeData: false` omit `logs.execution.workflow` too, or add a
`includeWorkflow` flag. The caller already knows the workflow, they just
submitted it.

---

### 2026-08-04 A live marketplace listing is invisible to a natural-language search

**Doing:** Confirming our freshly listed workflow could be discovered by other
agents, which is the entire point of listing.
**Expected:** `search_workflows({query: "aave health factor liquidation"})` to
find a listing whose title and description contain all four words.
**Got:** Zero results. The same listing ranks **first** for `query: "aave"` and
first for `sort: "recent"`. Multi-word queries appear to require every term to
match, so the more precisely an agent describes what it wants, the less it
finds.
**Cost:** ~10 minutes, but the real cost lands on sellers: a listing can be
live, correct and top-ranked, and still return nothing for the phrasing an
agent would naturally use.
**Fix:** OR the terms and rank by how many match, which is what anyone expects
from a search box. This is the same root cause as the earlier
`search_protocol_actions` entry, now with sharper consequences: that one cost a
developer a few minutes, this one silently costs marketplace sellers their
discovery and KeeperHub its 30% on calls that never happen.

**Bounty candidate:** yes. Discovery is the marketplace's whole value to a
seller, and `search_workflows` is the only surface agents have.

---

### 2026-08-07 The idempotency key is silently ignored in the request body

**Doing:** Building the onboarding starter template, and demonstrating replay
safety as part of it: submit a transfer twice with the same key, show that only
one transaction exists.
**Expected:** The documented behaviour. The MCP tool describes
`idempotency_key` as "Retrying with the same key and arguments returns the
original result instead of executing again, within a 24h window. Reusing a key
with different arguments returns a 409 conflict."
**Got:** Neither. Sending `idempotencyKey` in the JSON body, the natural
camelCase translation of the MCP parameter, produced **two separate
transactions with two different hashes**. Reusing the same key with a
*different* amount returned `202` and executed a third time rather than the
documented `409`.

The key is read from an HTTP `Idempotency-Key` **header**. Sent there it works
exactly as documented: the replay echoes the original `executionId` and
`transactionHash` and adds `idempotentReplay: true`. The body field is not
rejected, not warned about, just dropped.

**Cost:** ~20 minutes and three unintended Sepolia transactions. The real cost
was already banked, though: `agent/executor.ts` had been sending the key in the
body for days, with a comment explaining that this was "the difference between
a retry and a double spend when our process restarts mid-rescue". That
protection never existed. On a keeper that repays debt, a retry after a
timeout spends the user's money twice.

**Fix:** Two things, either of which would have been enough.
1. Reject a body-level `idempotencyKey` with a 400 naming the header. An
   unknown field in a *safety* parameter should never be silently discarded.
2. Make the MCP tool's parameter description say "sent as the Idempotency-Key
   HTTP header", since every REST caller reaches the API through that schema
   and the snake_case-to-camelCase mapping holds for every other field.

**Bounty candidate:** yes, and I would rank it above the search one. The others
cost a developer time; this one silently disarms the mechanism whose entire
purpose is preventing duplicate spends, and it fails in the direction of
executing more than you asked for. It is also invisible in testing: everything
returns 202 and looks like it worked.

---

<!-- Add entries below as they happen. Do not batch them up. -->
