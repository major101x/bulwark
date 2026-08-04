# GasGuard

**A liquidation-defense keeper that executes onchain through KeeperHub, and pays for its own gas.**

Built for the KeeperHub *Agents Onchain* hackathon. Full design in [SPEC.md](./SPEC.md).

---

## Reliability scorecard

Measured on Sepolia, 2026-08-02, four trials per cell. Method, caveats and raw
data in [chaos/RESULTS.md](./chaos/RESULTS.md).

| Scenario | KeeperHub | ethers (blind gas limit) | ethers (default) |
|---|---|---|---|
| Gas underpricing (0.05 gwei vs ~0.98 market) | **4/4 landed** | **0/4**, all stuck | no data |
| Congestion (4 concurrent from one wallet) | **4/4 landed** | 1/4 | 2/4 |
| Revert | all refused | all refused | all refused |

**Underpricing** is the clearest result and reproduces across runs. Both sides
got the same unusable gas price. KeeperHub adjusted and landed everything; the
blind baseline broadcast four transactions that never mined, confirmed from
chain state and clearable only by same-nonce replacement at 5x market.

**Congestion** cost the baselines two and three transactions to
`-32000 "already known"`. KeeperHub sequenced all four.

**Revert shows no difference.** The public RPC refuses to relay reverting
transactions, so nobody burned gas and there is nothing to separate. We report
that rather than dressing it up.

### The harness distinguishes three kinds of "it didn't work"

| Class | Meaning | Effect on the rate |
|---|---|---|
| failed / stuck | The backend under test did not deliver | Counted against it |
| prevented | Refused *because the call would revert* | Counted, separately |
| excluded | Our own network or RPC broke | Removed from the denominator |

That last row is why one cell reads "no data" instead of 0%. It also corrected a
real error: an earlier run scored KeeperHub 1/3 on underpricing, which read as a
reliability problem, when two of those trials were `fetch failed` from our own
connection. With exclusions the scenario reproduces at 4/4.

Four bugs in the harness itself, including one that would have credited an RPC
outage to the baseline as a safety feature, are written up in
[RESULTS.md](./chaos/RESULTS.md).

Reproduce with `npm run chaos -- --all --n 4`.

---

## What it does

People borrow against crypto collateral. If the collateral falls far enough, anyone
may **liquidate** them: repay part of the debt, seize collateral at a discount, and
the borrower eats a 5-10% penalty.

Spotting the danger is easy. Landing the rescue transaction is not: it has to execute
at 3am, during a gas spike, without being front-run. GasGuard watches positions,
decides whether a rescue is economically worth its gas, and executes through KeeperHub.

It also sells its own monitoring on the KeeperHub marketplace at ~$0.01 a call, so its
earnings fund its executions.

## The interesting part: knowing when *not* to act

Any agent can fire a repay when a health factor dips. GasGuard computes whether the
rescue is worth the gas, and declines when it is not:

```
HF 1.120 → ARMED. P(liquidation) 0.7% over next 24h, loss if it happens $250.00,
expected loss $1.85. Cheapest rescue REPAY at $4.44. Ratio 0.4× vs 3× margin:
holding, gas not justified yet.
```

Liquidation probability uses a **first-passage** model, not an endpoint one: a position
that dips below HF 1.0 mid-window and recovers still gets liquidated, because liquidators
watch every block. By the reflection principle that roughly doubles the naive estimate.

Health factor 1.10 comes out at a ~2.3% chance of touching liquidation within a day,
which lines up with how often collateral actually drops 9% in 24 hours.

## Architecture

```
Aave position (Sepolia)
   │
   ├─ hf-watch workflow (KeeperHub, every N blocks)
   │     └─ POST /evaluate ──▶ agent: classify → price → decide
   │                              │
   │                              ├─ RESCUE ──▶ rescue workflow (KeeperHub)
   │                              │              approve → repay → re-read HF → verify
   │                              └─ HOLD
   │                                     │
   └────────────────────── attest to GuardianLog on Ethereum mainnet ◀┘
                           (gas sponsored, zero capital, holds logged too)
```

Both rescues *and* holds are attested. A keeper that only records its successes is not
an audit trail, and the declined rescues are the interesting judgment calls.

## Status

**Autonomous liquidation defense is live, and every decision is attested to Ethereum mainnet.**

A KeeperHub workflow watches the position every 50 Sepolia blocks and rescues it
with no local process running. Verified both branches on 2026-08-02:

| Health factor | Condition | Outcome |
|---|---|---|
| 1.3004 healthy | false | stopped after 3 nodes, zero transactions |
| 1.0400 critical | true | rescued to **1.3192** in 26.5s |

### Onchain, all gas sponsored, all zero capital

| What | Chain | Link |
|---|---|---|
| `GuardianLog` deployment | mainnet | [`0x62938be3...`](https://etherscan.io/tx/0x62938be3d006d6a0757c827f3f463f0ea9043f8defb521e7d456b4287636ef7d) |
| `GuardianLog` contract | mainnet | [`0x06D8C09B...`](https://etherscan.io/address/0x06D8C09B5dbb9f9Bb96B7B20a351cdC5e16644D3) |
| Decision attestation | mainnet | [`0x2d60efde...`](https://etherscan.io/tx/0x2d60efde2ceb3f14cbe150e59fb992aaa588738e3816f33f7b29c38cddcf48c9) |
| Rescue: approve | Sepolia | [`0xfc3555ad...`](https://sepolia.etherscan.io/tx/0xfc3555ad6cdd0d6db25bf33a33082438b7f74955f028a7b666a69a5b451e4cfa) |
| Rescue: supply | Sepolia | [`0xc89edff9...`](https://sepolia.etherscan.io/tx/0xc89edff99b3937047103b4e601722c6de98542b70c2b41537ba46cf48cfd368d) |

The mainnet attestation carries the Sepolia rescue's hash in
`remediationTxHash`, so the public record and the economic action are linked.
Decoded, it reads: HF 1.0400, action AddCollateral, expected loss $4.74, rescue
cost $1.18.

KeeperHub has no deploy action, so `GuardianLog` went up through a CREATE3
factory, whose `deploy(bytes32,bytes)` is an ordinary call and therefore
reachable. The address was predicted before deploying and the on-chain runtime
code verified byte-identical to the local compile.

| Component | State |
|---|---|
| Risk tiers, probability model, cost/benefit | done, 56 tests passing |
| Remediation selection and amount math | done, verified against the live position |
| Position tooling (`pos:*` scripts) | done: open, fund, danger, status, evaluate |
| `hf-watch-critical` workflow | done, enabled, both branches verified |
| `GuardianLog` on mainnet | **deployed, first attestation written** |
| KeeperHub response shapes | verified from real executions (`agent/keeperhub-types.ts`) |
| KeeperHub REST paths | unconfirmed; verified calls went through MCP |
| ARMED-tier agent loop | decision logic done, not yet wired to a trigger |
| Attestation from the agent | done by hand via MCP; not yet automatic |
| Chaos harness | **runnable end to end, 2 of 3 scenarios differentiate** ([RESULTS](./chaos/RESULTS.md)) |
| Marketplace listing / x402 | not started, and settlement is mainnet-only |
| Dashboard | not started |

Open questions are resolved in [SPEC.md §14](./SPEC.md).

### How the work is split

The CRITICAL tier runs **inside KeeperHub**, server-side, with a fixed-size
collateral top-up. It needs no local process, so the position stays defended even
when our agent is down. Economics are deliberately bypassed there: at HF 1.05 a
passing gas spike is not a reason to let a position liquidate.

The **agent** owns the ARMED tier, where the interesting behaviour is declining to
act. That reasoning is too involved for condition nodes and it is where the
cost/benefit model earns its place.

Open questions are resolved in [SPEC.md §14](./SPEC.md).

## Running what exists

```bash
npm install
npm test          # 56 tests, no network required
npm run typecheck
```

The decision logic is pure and fully testable offline: no RPC, no account, no keys.

To run the agent, copy `.env.example` to `.env`. It starts with `DRY_RUN=1`, which
computes and logs decisions without executing anything.

```bash
npm run agent
```

## Security

The agent never handles a private key. KeeperHub keeps them in Turnkey enclaves, and
the only key in this repo's config is `CHAOS_BASELINE_PRIVATE_KEY`, a throwaway
Sepolia key used solely by the naive baseline in the chaos harness, holding worthless
testnet funds.

## Layout

```
agent/        decision logic (risk, remediation) + execution + attestation
chaos/        failure injectors and the reliability harness
contracts/    GuardianLog.sol, the onchain audit trail
workflows/    exported KeeperHub workflow JSON
docs/         friction log (bounty input), architecture notes
starter-template/  zero-to-first-transaction, for the onboarding bounty
```

## License

MIT
