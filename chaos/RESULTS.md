# Chaos harness results

Measured on Sepolia, 2026-08-02. Four trials per cell. Raw per-trial data in
`chaos/runs/`.

Reproduce: `npm run chaos:fund`, then `npm run chaos -- --all --n 4`.

## Backends

| Name | What it is |
|---|---|
| `keeperhub` | Execution through KeeperHub: simulation, gas handling, managed nonces, sponsorship |
| `naive` | Plain ethers.js, static gas price, one attempt, default `estimateGas` pre-flight |
| `naive-blind` | Same, plus a hardcoded `gasLimit` so ethers skips estimation entirely |

`naive-blind` exists because of something we got wrong at first. We assumed a
simple ethers agent broadcasts doomed transactions and burns gas. It does not:
ethers estimates by default and the estimate reverts before anything is sent.
Agents lose that protection only when they hardcode a gas limit, which is a real
and common pattern, since it saves an RPC round trip and stops estimation
failures from blocking sends. The gap between the two variants is the point.

## Results

| Scenario | Backend | Landed | Stuck | Failed | Excluded | Median latency |
|---|---|---|---|---|---|---|
| gas-underpricing | keeperhub | **4/4 (100%)** | 0 | 0 | 0 | 13,415ms |
| gas-underpricing | naive-blind | **0/4 (0%)** | 4 | 0 | 0 | n/a |
| gas-underpricing | naive | no data | 0 | 0 | 4 | n/a |
| congestion | keeperhub | **4/4 (100%)** | 0 | 0 | 0 | 31,033ms |
| congestion | naive | 2/4 (50%) | 0 | 2 | 0 | 13,053ms |
| congestion | naive-blind | 1/4 (25%) | 0 | 3 | 0 | 8,056ms |
| revert | all three | 0/4, all prevented | 0 | 0 | 0 | n/a |

### Gas underpricing: the clearest result

The baseline was pinned to a hardcoded 0.05 gwei against a market of roughly
0.98 gwei, with a hardcoded gas limit so estimation never intervened. That is
what a static gas price becomes the moment the network moves. KeeperHub was
given a thin gas budget and allowed to manage it.

**The two sides were not handed identical instructions, and an earlier version
of this file said they were.** The scenario asks KeeperHub for a `0.6`
multiplier, which reaches the API as `priorityFeeGwei: "0.6"`, an absolute tip
rather than a fraction of market. Against a ~1 gwei market that is not an
underbid at all. So this row measures managed execution against a static
one-shot price, which is the real-world comparison, but it is not a symmetric
underbid. See bug 6 below.

**KeeperHub landed 4/4. The blind baseline landed 0/4**, with all four still
sitting in the mempool at the deadline. Confirmed independently from chain
state: the baseline's confirmed nonce did not move while its pending nonce
advanced by four, so four transactions were broadcast and none mined. Clearing
them required explicit same-nonce replacements at five times market price.

This is the gas-escalation claim, measured. Reproduced across two separate runs.

### Congestion: nonce management

Four transactions fired concurrently from one wallet. KeeperHub sequenced all
four. The ethers baselines landed 2/4 and 1/4, losing the rest to
`-32000 "already known"`.

Honest caveat on the mechanism: our workload submits an identical call each
time, so concurrent sends produce byte-identical transactions and the node
rejects duplicates. A workload with varying calldata would instead show
same-nonce replacement drops. Same root cause, no managed nonce, but the
specific error would differ.

### Revert: no differentiation, and we are not inventing any

All three backends refused all four reverting calls, so there is nothing to
separate them. The public RPC rejects reverting transactions at submission, and
even `naive-blind` with estimation disabled got
`transaction execution reverted (action="sendTransaction")`. Nothing reached a
block, so no gas was burned by anyone.

The scenario as designed, "does the backend waste gas on doomed calls", cannot
be answered on this RPC. Answering it needs an endpoint that relays reverting
transactions, or a private mempool.

## Why some cells say "no data"

The `naive` cell under gas-underpricing has four excluded trials and therefore
reports **no data** rather than 0%.

All four failed with `missing revert data (action="estimateGas")` on an
`approve(0)` call, which cannot revert. That is the public RPC failing to
answer, not a measurement of the baseline. Counting it as a baseline failure
would have flattered KeeperHub; counting it as a save would have flattered the
baseline. It is excluded from the denominator and shown separately.

The harness distinguishes three things that all look like "it didn't work":

| Class | Meaning | Effect on the rate |
|---|---|---|
| failed / stuck | The backend under test did not deliver | Counted against it |
| prevented | The call was refused *because it would revert* | Counted, separately |
| excluded | Our network or RPC broke | Removed from the denominator |

This mattered. An earlier run scored KeeperHub 1/3 on underpricing, which read
as a reliability problem. Two of those three trials were `fetch failed` from our
own connection. With exclusions, the same scenario reproduces at 4/4.

## Bugs this harness found in itself

Recorded because a measurement tool that has never been wrong has not been
looked at hard enough.

1. **`estimateGas` errors were all scored as "prevented"**, which credited an
   RPC outage to the baseline as though it were a deliberate safety feature.
   Prevention now requires evidence the node decoded an actual revert.
2. **The underpricing scenario underpriced only KeeperHub.** The baselines' gas
   price is fixed at construction, so the first version of that row compared
   nothing. Scenarios now carry their own baseline gas price.
3. **BigInt broke the KeeperHub path entirely.** `JSON.stringify` throws on it,
   so the first run's KeeperHub calls never left the process.
4. **No hard per-trial deadline.** A stuck baseline transaction made later
   ethers calls block on the same wallet's nonce, and two runs had to be killed.
   Fixed: every trial races a harness-level deadline and is recorded as
   abandoned if it blows it. Abandoned is tracked apart from stuck, because
   abandoning means we stopped watching, not that we observed non-inclusion.
5. **Stuck transactions contaminated the following scenario.** The harness now
   clears the baseline wallet between backends rather than at the end.
6. **The fix for bug 2 overshot, and the write-up followed it.** Giving the
   scenario its own baseline gas price was right, but the matching `0.6`
   multiplier sent to KeeperHub is transmitted as `priorityFeeGwei: "0.6"`, an
   absolute tip, not 0.6x market. The intent was a symmetric underbid; the wire
   format is a healthy tip. Found by reading `agent/executor.ts` against
   `chaos/injectors.ts` rather than trusting the comment in either. The measured
   result stands, the "same bad instruction" framing does not, and this file
   claimed the framing for several days.

## What we did not run

Printed on every run rather than quietly omitted:

| Scenario | Why not |
|---|---|
| `nonce-collision` | Neither backend exposes an explicit nonce to collide |
| `rpc-flakiness` | Needs a proxy that can drop connections mid-submit |
| `cold-start` | Needs a freshly funded wallet per trial |

## Measurement limits

- **Gas used is unavailable for KeeperHub.** The direct-execution REST endpoint
  returns only `{ executionId, status }` and there is no REST route for detail.
  Those cells print `n/a`, never `0`, since zero would read as "no gas wasted".
- **KeeperHub latency includes queueing and confirmation**, because the POST
  blocks until the execution is terminal. That is what a caller experiences, so
  it is the honest number, but it is not comparable to the baseline's
  time-to-broadcast.
- **Four trials per cell** is enough to show a 4/4 versus 0/4 split and not
  enough to put error bars on latency.
