# Your first KeeperHub transaction

Land a real transaction on a public blockchain in about a minute.

**You do not need:** testnet ETH, a faucet, MetaMask, a seed phrase, or any
prior blockchain experience. You need Node 18+ and a free account.

## Three steps

```bash
cp .env.example .env     # 1. then paste your API key into it
npm install              # 2.
npm run first-tx         # 3.
```

Get the API key at [app.keeperhub.com](https://app.keeperhub.com), then
profile → API keys. It starts with `kh_`.

That is the whole setup. If step 3 prints a link to Etherscan, you are done.

```
KeeperHub: your first transaction

  wallet    0x2Ac0C346502571c8Ef320e2768702589800b14F8
  chain     11155111 (Sepolia testnet)
  sending   0 ETH to yourself

  simulated OK, estimated gas 21227

  Executed.

  status    completed
  execution xvsqhriwnryzprsdju7m3
  tx        0xbd8a68d0e9a2d5005fa984c3dab4f0796411c69693eaba561b3c98551cc2c75a

  https://sepolia.etherscan.io/tx/0xbd8a68d0e9a2d5005fa984c3dab4f0796411c69693eaba561b3c98551cc2c75a
```

That output is from a real run. You can open the link.

## Why this needs no money

Two reasons, and both are the point of the platform.

**KeeperHub sponsors the gas.** Every transaction costs a fee, normally paid
from your own balance. KeeperHub pays it for you. Measured rather than assumed:
the wallet balance across a completed transfer moved by exactly 0 wei.

**The transfer is for zero.** You are sending yourself nothing, so there is no
balance to have. Once you have testnet ETH you can set `AMOUNT` and send a real
quantity, but nothing about the first run requires it.

You also never handled a private key. KeeperHub holds it in a hardware enclave
and signs on your behalf, which is why there is no seed phrase anywhere in this
setup.

## What the script does, and why

It is one file, about 200 lines, meant to be read.

**It asks the API which wallet you have.** `GET /api/integrations` returns it,
so you do not have to go find your address and paste it into a config file.

**It simulates before executing.** A simulation is free, instant, and tells you
whether the call would revert. There is no reason to skip it, and the habit is
worth forming now: on mainnet the difference is real money.

**It uses an idempotency key.** Run `npm run first-tx` a second time and watch:

```
  This exact transaction was already sent, so nothing new happened.
  That is the idempotency key doing its job.
```

Same execution id, same transaction hash, no second transaction. This is what
protects you when a request times out and you do not know whether it landed.
Retry with the same key and you either get the original result or the first
real attempt, never two.

## Two things that will trip you up

Both cost us real time. Neither is guessable.

**The recipient field is `recipientAddress`.** Not `toAddress`, which is what
you get by camel-casing the MCP tool's `to_address`. Anything else returns a
400 naming the field it wanted.

**The idempotency key is an HTTP header, not a body field.** `Idempotency-Key`,
alongside `authorization`. If you put `idempotencyKey` in the JSON body it is
accepted, silently ignored, and your call executes again. We found this by
sending the same key twice and getting two different transaction hashes. If you
are writing a keeper that repays debt, that is a double spend.

## When you need funds

The first transaction needs nothing. Everything after it does.

### Test tokens: skip the faucet website

```bash
npm run mint             # 10 LINK
npm run mint -- USDC 25  # 25 USDC
npm run mint -- DAI 500
```

This calls Aave's Sepolia faucet contract directly through KeeperHub. Sponsored
gas, no private key, and it works whether or not the faucet websites do.

That last part matters more than it should. On 2026-07-31 the `gho.aave.com`
faucet page did not work and `app.aave.com` had switched its bridge to Base,
which left no working route to Sepolia test tokens. The faucet is only a
contract, so a contract call sidesteps the whole problem. Supported tokens are
LINK, USDC, DAI and WETH.

### Sepolia ETH

You need this only once you move past sponsored calls, for example if you sign
transactions yourself. Get it from the
[Alchemy faucet](https://www.alchemy.com/faucets/ethereum-sepolia).

Order matters if you go the website route: claim Sepolia ETH **before** test
tokens. Claiming a token is itself a transaction and a transaction needs gas.
The page loads, the button works, and the claim cannot be submitted. That is the
classic first-hour mistake, and `npm run mint` avoids it entirely because
KeeperHub pays.

### Base Sepolia USDC

Only for x402 payment work. [faucet.circle.com](https://faucet.circle.com/).

### Two wallets, not one

Your own wallet and your KeeperHub wallet are different addresses. Once you are
past sponsored calls, fund both. Forgetting the second is the most common
failure at this stage, and the error does not point at the cause.

## Troubleshooting

Every failure in this script explains what to do next rather than what broke
internally. If you hit something it does not cover:

| Symptom | Cause |
|---|---|
| `Your API key was rejected` | Key is wrong, truncated, or revoked. Make a new one. |
| `No wallet is connected` | Create one at app.keeperhub.com → Integrations. KeeperHub can generate it for you. |
| `Out of execution quota` | The free tier is 5,000 executions a month. |
| `The API rejected the request body` | You edited a field name. Check them against the comments in `first-tx.ts`. |

## Next

Run `npm run mint` to get test tokens, then go build something that uses them.

If you want another transaction from this template, change `AMOUNT` in `.env`
and run `first-tx` again. The idempotency key is derived from the amount, so a
different amount is a genuinely new transaction rather than a replay.

## Files

| File | What it is |
|---|---|
| `first-tx.ts` | The one-command first transaction. Start here. |
| `mint-test-tokens.ts` | Aave Sepolia test tokens without the faucet website. |
| `.env.example` | One required variable. Copy to `.env`. |
