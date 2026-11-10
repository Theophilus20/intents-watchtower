# Runbook

## 1. Deploy the contract

```bash
OWNER=you.testnet ./scripts/deploy-testnet.sh
```

This builds `watchtower.wasm` with `cargo near`, creates `watchtower.you.testnet`, initialises it with quorum 1, registers three watcher keys from `data/watcher-*.json`, and raises quorum to 2 with escalation threshold 1. Create the watcher accounts (`w1.watchtower.you.testnet`, …) only if they will pay their own gas; with a relayer they can stay key-only identities.

Before mainnet: transfer ownership to a multisig or DAO (`transfer_ownership`), add at least one guardian on a separate key (`add_guardian`), and run watchers under different operators.

## 2. Configure a watcher

```bash
cp config/watchtower.example.json watchtower.config.json
cp .env.example .env    # WATCHER_ACCOUNT_ID, WATCHER_SECRET_KEY, optional relayer, NEAR AI, Telegram
npm run watch -- --config watchtower.config.json --once     # dry run: collect, evaluate, print
npm run watch -- --config watchtower.config.json --submit   # live
```

Each watcher **must** use RPC providers the other watchers do not use. Agreement between watchers is only meaningful if their data paths are independent.

### Finding custody addresses

**Automatically:** run `npm run custody`. It reads the recent history of each bridge token contract from FastNEAR's
transactions API (a few dozen requests) and adds whatever the watchers recorded in `data/bridge-events-*.jsonl`. For each bridged asset it traces withdrawals to
the payout's sender (hot wallet, via the PoA bridge's `withdrawal_status`), deposits to the deposit address that
received exactly the credited amount, and from there to where deposits are swept and who refills the hot wallets.
On Bitcoin and Litecoin it pages back through up to 500 of each hot wallet's transactions for the wallets that
refill it (a vault usually also takes the excess back). Payout recipients are users and are skipped; a refiller
that alone holds more than 1.5× what users are owed is an exchange or another service and is listed as such but
left out of the sum, so it can't hide a shortfall. It also reconciles payouts: over the window both histories
cover, it sets what users withdrew on NEAR (each `WITHDRAW_TO` memo names an address) against everything the hot
wallets sent out, and lists coins sent to addresses no withdrawal named as "unmatched payout", with their balances.
Those are leads for a gap, never counted as backing. `npm run custody -- --deep` (optionally `--deep 2000`) traces
up to 600 deposits per asset to the deposit addresses they paid and reads every balance, to measure the coins
users deposited that the bridge hasn't swept into its hot wallet yet. It takes several minutes.
`--history` (optionally `--history 2000`) reads the same long NEAR history and 1,000 of each hot wallet's
transactions without tracing every deposit, and works the gap between what users are owed and what the hot wallet
holds back through both histories: a gap already there at the start of the window is older than the history, one
that grows during it is live and the timeline shows when.
When the treasury is found but holds less than users are owed by a steady amount, the run says "partly verified:
yes" with the alarm levels it measured, or "partly verified: no" and which test failed (see METHODOLOGY.md).
`npm run custody:apply -- --partial --history --only btc:bitcoin` writes it: those routes then read "partly verified"
(never green) and go red if the shortfall grows.
`npm run custody -- --origin --only btc:bitcoin` finds when and how a shortfall appeared. It reads the treasury's
whole history (complete when its flows add up to its balance now), asks an archival NEAR RPC for the token's supply
on past dates, and samples the shortfall over the treasury's life. Each reading is the median of three an hour apart,
because a deposit is credited before it is swept and a withdrawal burned before it is paid. Where the shortfall moved,
it halves the stretch down to a few hours, finds every block in it where the supply changed, and prints each
mint or burn with its transaction, account and memo; for a deposit, the Bitcoin transaction behind it, the address
it paid and what that address holds now. Tokens minted into the bridge's own account are owed to no user and can be
subtracted like `issuerAccounts`; coins still sitting in a deposit address the bridge controls are backing; tokens
users hold with no coins anywhere make the shortfall real.
It prints every address with the evidence for it and the share of the NEAR supply they hold. For PoA assets it
also asks the bridge (`recent_deposits`) which deposit addresses it gave recent depositors and reports the coins
still waiting there to be swept: evidence for any gap, never added to custody, because those addresses change
within hours. Each token's line says which events it logged, so "0 deposits" explains itself. Review the list, then
`npm run custody:apply` writes hot wallets, plus custody only for assets where the addresses hold at least the whole
supply (less could be a missing address, and would raise false alarms). The old config is kept as `.bak`.

`npm run custody -- --holders` reads only NEAR. It shows a bridged token's supply, what the bridge's own accounts hold
(directly and inside the intents ledger, which no user is owed) and the largest holders. Use it to rule out that a
shortfall is tokens the bridge holds itself.

`npm run custody -- --fees --only btc:bitcoin` adds up the miner fees around a treasury over its whole history: what its
own payments paid, and what transactions paying into it paid (an upper limit, since not every sender is the bridge).
It compares the total with the usual shortfall. Progress is saved in `data/fees-<address>.json`; run it again to continue.

**By hand:**

- **PoA bridge assets** (`*.omft.near`): deposit addresses come from the bridge's `deposit_address` JSON-RPC (`https://bridge.chaindefuser.com/rpc`); withdrawals are paid from bridge hot wallets visible as the sender of payout transactions for `ft_burn` events. Collect both sets by following a handful of known deposits and withdrawals on the home chain.
- **HOT bridge assets** (`v2_1.omni.hot.tg`, e.g. USDT and BNB on BSC): HOT keeps one locker contract per EVM chain
  that every deposit is paid into and every withdrawal paid out of, `0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd` on BSC
  (from HOT's own `@hot-labs/omni-sdk`, `treasuryDefaultContract`). The token id `56_<base58>` encodes the BSC token
  contract; `npm run custody` decodes it and reads the locker's balance of that token (native BNB for `56_1111…`).
- **Omni bridge Bitcoin**: each deposit uses its own address; build the set from bridge events and keep adding as new deposits appear.
- **HOT-bridged EVM assets** (BSC, Polygon, …): the hot wallet is the sender of withdrawal payouts.

Until an asset's custody set is complete, leave it out of `assets`; routes touching it report `CUSTODY_DATA_STALE` (unknown), which is the honest answer.

## 3. Operate

| Signal | Meaning | Action |
|---|---|---|
| `watcher_disagreement` event | Watchers hashed different inputs for the same epoch | Compare their `inputsDigest`; one data source is lagging or lying. Rotate its provider. |
| Routes `stale` on-chain | Watchers stopped attesting | Check watcher processes, relayer balance and RPC limits. |
| `CHAIN_DATA_STALE` everywhere for one chain | That chain's RPC is down | Add a fallback RPC for that chain. |
| Many `GHOST_CREDIT_PENDING` on one asset | Deposit observer lagging | Check the home-chain reader; widen nothing until you know why. |
| Real incident | Route red with ghost credits / backing hole | Guardian may `set_override(route, "red", "incident-<id>")` to hold it red while operators investigate; clear it after quorum shows recovery. |

## 4. Rotate a watcher key

1. `npm run cli -- keygen` on the watcher host.
2. Owner calls `add_watcher` with the same account id and the new public key (it overwrites).
3. Restart the watcher with the new secret. Old signatures stop verifying immediately.

## 5. Replays and audits

- `npm run replay -- all --json data/replays.json` writes every frame and transition.
- Any stored verdict can be re-verified: `PgStore.storedReport(route, epoch)` + `verifyVerdict(...)` recomputes the hash that watchers signed.

## Running in the cloud

One container can run all three watchers, so the status page stays fresh when your computer is off.

1. On the computer that holds the keys, run `npm run cloud:bundle`. It packs `watchtower.config.json`, the three
   watcher keys and the relayer key into one value in `data/cloud-bundle.txt`. Treat that file like the keys.
2. On the host (Railway, Fly or any container host), deploy this repository. It builds from the `Dockerfile`.
3. Add one secret variable, `WATCHTOWER_BUNDLE`, and paste the file's contents as its value.
4. Stop the watchers on your computer, so only one copy of each signs.

The service restores the files, starts watcher 1, 2 and 3 twenty seconds apart and restarts any that stops. Its log
prefixes each line with `[w1]`, `[w2]` or `[w3]`. This is the demo arrangement: in production each watcher runs on a
different machine, operated by a different person.
