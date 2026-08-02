# Chaos harness results

Measured on Sepolia, 2026-08-02. Raw per-trial data in `chaos/runs/`.

Reproduce: `npm run chaos:fund`, then `npm run chaos -- --all --n 3`, and
`npm run chaos:unstick` between runs.

## Backends

| Name | What it is |
|---|---|
| `keeperhub` | Execution through KeeperHub: simulation, gas handling, managed nonces, sponsorship |
| `naive` | Plain ethers.js, static gas price, one attempt, default `estimateGas` pre-flight |
| `naive-blind` | Same, plus a hardcoded `gasLimit` so ethers skips estimation entirely |

`naive-blind` exists because of something we got wrong at first. We assumed a
simple ethers agent broadcasts doomed transactions and burns gas. It does not:
ethers estimates gas by default and the estimate reverts before anything is
sent. Agents lose that protection only when they hardcode a gas limit, which is
a real and common pattern (it saves an RPC round trip and stops estimation
failures from blocking sends). Both variants are measured because the difference
between them is the interesting part.

## Results

Three trials per cell. Small, and reported as such.

| Scenario | Backend | Landed | Stuck | Median latency | Status |
|---|---|---|---|---|---|
| gas-underpricing | keeperhub | **3/3** | 0 | 11,963ms | solid |
| gas-underpricing | naive-blind | **0/3** | 3 | n/a | solid |
| gas-underpricing | naive | 0/3 | 0 | n/a | contaminated, see below |
| congestion | keeperhub | **3/3** | 0 | 39,189ms | solid |
| congestion | naive | 1/3 | 0 | 8,036ms | solid |
| congestion | naive-blind | 1/3 | 0 | 15,869ms | solid |
| revert | all three | 0/3 | 0 | n/a | inconclusive, see below |

### Gas underpricing: the clearest result

Both sides were handed the same bad instruction, a gas price of 0.05 gwei
against a market of roughly 0.98 gwei.

**KeeperHub landed all three. The blind baseline landed none**, and all three of
its transactions were still sitting in the mempool at the 45 second deadline.
Confirmed independently from chain state: the baseline wallet's confirmed nonce
stayed at 14 while its pending nonce reached 17, so three transactions had been
broadcast and none mined. Clearing them needed explicit same-nonce replacements
at five times market price (`npm run chaos:unstick`).

This is the gas-escalation claim, measured: given a price that cannot mine,
KeeperHub adjusted and the transactions landed.

### Congestion: nonce management

Three transactions fired concurrently from one wallet. KeeperHub sequenced all
three. Both ethers baselines landed one and lost two to
`-32000 "already known"`.

Honest caveat on the mechanism: our workload submits an identical call each
time, so concurrent sends produce byte-identical transactions and the node
rejects the duplicates. A workload with varying calldata would instead show
same-nonce replacement drops. The root cause is the same either way, no managed
nonce, but the specific error would differ.

### Revert: inconclusive, and we are not claiming otherwise

We could not demonstrate wasted gas on reverting transactions, because the
public RPC refuses to relay them. Even `naive-blind`, with estimation disabled,
got `transaction execution reverted (action="sendTransaction")`: the node
simulated at submission and rejected it. Nothing reached a block, so no gas was
burned by anyone and there is nothing to compare.

KeeperHub also rejected the reverting call, in 2.9 seconds. That is faster than
one Sepolia block, so it cannot have been mined either, which means it was
refused at simulation. That inference comes from latency, not from an API field,
because there is no REST route exposing execution detail.

To measure this properly we would need an RPC that relays reverting
transactions, or a private mempool.

### The contaminated cell

The `naive` row under gas-underpricing reads 0/3, but for the wrong reason: all
three failed with `missing revert data (action="estimateGas")` on an
`approve(0)` call, which cannot revert. That is an RPC estimation failure,
almost certainly caused by leftover stuck nonces from the previous run polluting
pending state. It is not a measurement of anything and should not be cited.

This also exposed a bug in our own scoring, now fixed: any `estimateGas` error
was being classified as "prevented", which would have credited an RPC outage to
the baseline as though it were a deliberate safety feature. Prevention now
requires evidence the node actually decoded a revert.

## What we did not run

Three scenarios are defined but not runnable, and the harness prints them on
every run rather than quietly omitting them:

| Scenario | Why not |
|---|---|
| `nonce-collision` | Neither backend exposes an explicit nonce to collide |
| `rpc-flakiness` | Needs a proxy that can drop connections mid-submit |
| `cold-start` | Needs a freshly funded wallet per trial |

## Measurement limits

- **Gas used is unavailable for KeeperHub.** The direct-execution REST endpoint
  returns only `{ executionId, status }` and there is no REST route for detail.
  Those cells print `n/a`, never `0`, because zero would read as "no gas
  wasted", which is a claim we cannot support.
- **KeeperHub latency includes queueing and confirmation**, since the POST
  blocks until the execution is terminal. That is what a caller experiences, so
  it is the fair comparison, but it is not directly comparable to the
  baseline's time-to-broadcast.
- **Three trials per cell** is enough to show a 3/3 versus 0/3 split and not
  enough to put error bars on latency.
- Transient transport errors are retried up to three times on the KeeperHub
  path. `fetch failed` is not an answer from the API, and counting it as a
  KeeperHub failure would put local network flakiness on its scorecard.

## Known harness limitation

There is no hard per-trial timeout above the backend call. A stuck baseline
transaction can wedge a run: after the underpriced transactions pile up, later
ethers calls block on the same wallet's nonce and the process hangs rather than
failing the trial. Two runs had to be killed and cleared with
`npm run chaos:unstick`. Fixing this means racing every trial against a
harness-level deadline, not just the receipt wait.
