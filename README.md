# GasGuard

**A liquidation-defense keeper that executes onchain through KeeperHub, and pays for its own gas.**

Built for the KeeperHub *Agents Onchain* hackathon. Full design in [SPEC.md](./SPEC.md).

---

## Reliability scorecard

> ⏳ **Not yet measured.** The harness lands day 7-8; these are the columns it fills.
> Numbers below are the table shape, **not results**. Do not cite them.

| Scenario | KeeperHub | Naive ethers.js |
|---|---|---|
| Gas underpricing | n/a | n/a |
| Congestion (20 concurrent) | n/a | n/a |
| Nonce collision | n/a | n/a |
| Revert (repay > debt) | n/a | n/a |
| RPC flakiness | n/a | n/a |
| Cold start | n/a | n/a |

Reproduce with `npm run chaos -- --all`. Method in [SPEC.md §7](./SPEC.md).

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

**Autonomous liquidation defense is live.** A KeeperHub workflow watches the
position every 50 Sepolia blocks and rescues it without any local process running.

Verified both branches on 2026-08-02:

| Health factor | Condition | Outcome |
|---|---|---|
| 1.3004 healthy | false | stopped after 3 nodes, zero transactions |
| 1.0400 critical | true | rescued to **1.3192** in 26.5s |

Rescue transactions, both gas sponsored by KeeperHub:
[approve](https://sepolia.etherscan.io/tx/0xfc3555ad6cdd0d6db25bf33a33082438b7f74955f028a7b666a69a5b451e4cfa) ·
[supply](https://sepolia.etherscan.io/tx/0xc89edff99b3937047103b4e601722c6de98542b70c2b41537ba46cf48cfd368d)

| Component | State |
|---|---|
| Risk tiers, probability model, cost/benefit | done, 44 tests passing |
| Remediation selection and amount math | done, verified against the live position |
| Position tooling (`pos:*` scripts) | done: open, fund, danger, status, evaluate |
| `hf-watch-critical` workflow | **done, enabled, both branches verified** |
| KeeperHub response shapes | verified from real executions (`agent/keeperhub-types.ts`) |
| KeeperHub REST paths | unconfirmed; verified calls went through MCP |
| ARMED-tier agent loop | decision logic done, not yet wired to a trigger |
| `GuardianLog.sol` | written, not yet deployed |
| Chaos harness | scored and tested; backends not yet wired to live chains |
| Marketplace listing / x402 | not started, and settlement is mainnet-only |
| Dashboard | not started |

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
npm test          # 44 tests, no network required
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
