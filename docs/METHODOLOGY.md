# Methodology

How the engine turns observations into a route verdict. Code references point at `packages/engine/src`.

## Units and determinism

- Token amounts are integers in smallest units (`bigint`). Money thresholds are integer **USD cents**. Ratios are integer **parts per million** (1,000,000 = 100%).
- Every input batch is folded into a hash chain (`inputsDigest = sha256(prev + sha256(canonical(batch)))`).
- A verdict's `reportHash` is `sha256` of canonical JSON over the full verdict (status, score, reasons, every component with its metrics and evidence) plus engine version, epoch, time and `inputsDigest`. Canonical JSON sorts keys and **rejects floats**, so watchers on different machines produce byte-identical hashes.
- Collectors pin data to the epoch boundary (one epoch = one minute): NEAR blocks with timestamp ≤ the boundary, home-chain state at the last block before it. In replays and simulations, watchers fed the same batches sign the same hash. Live watchers read chains seconds apart and almost never hash identical inputs, so the contract's quorum is on the **verdict**: each watcher's latest fresh vote counts, red or amber needs `escalation_threshold` votes, green needs `quorum` agreeing votes with no alarm standing, and the stored score and safe size are the most cautious of the agreeing votes. The hash still pins each vote to the exact evidence behind it.

## Check 1: proof of backing (`checks/backing.ts`)

```
backing = custody_on_home_chain / (credited_on_NEAR + pending_withdrawals + deposits_in_flight)
```

- **credited**: total supply of the bridge token (`ft_total_supply` on e.g. `btc.omft.near`, or `mt_supply` for multi-token bridges).
- **pending withdrawals**: burned on NEAR, not yet paid on the home chain. Still in custody, still owed.
- **deposits in flight**: seen on the home chain, not yet credited. Already in custody and owed to the depositor. The engine computes this itself from the ghost-credit matcher's open deposits.

The original spec put in-flight deposits in the numerator. That double-counts them (they are already in the custody balance) and overstates backing during busy periods, so they are on the liability side here.

| Ratio | Status |
|---|---|
| ≥ 100% | green, or amber `BACKING_DROP_FAST` if it fell ≥ 0.2 points below its 15-min median |
| 99.5% – 100% | amber `BACKING_TOLERANCE`, or red if also falling fast |
| < 99.5% | red `BACKING_BELOW_THRESHOLD`, penalty 20 + 2 per 0.1 point missing (max 40) |
| custody or supply older than 10 min | unknown `CUSTODY_DATA_STALE` / `SUPPLY_DATA_STALE` |

Native NEAR assets (wNEAR, Circle's native USDC) are issuer-backed and skip checks 1–3.

## Check 2: ghost credits (`matcher.ts`, `checks/ghost.ts`)

Every credit (bridge `ft_mint` / `mt_mint`, attributed to the real user through the matching `intents.near` `mt_mint` in the same transaction) must pair with a deposit into custody on the home chain.

Pairing rules, in order: same asset; if the bridge stamped the source tx into the memo it must be that tx; if both sides name a NEAR account they must agree; `credit ≤ deposit` and the difference fits the fee allowance (1% or $5, whichever is larger); the deposit is at most 6 hours older than the credit and at most the chain's observer window newer. Ties break on exact tx, smallest amount gap, closest time, lowest id, so every watcher pairs identically.

| Unpaired credit | Status |
|---|---|
| younger than 3 min (grace for polling lag) | not judged |
| inside the chain window, value ≥ $10K | amber `GHOST_CREDIT_PENDING` |
| its account has withdrawn ≥ 50% of its value since the credit | **red `GHOST_CREDIT_WITHDRAWN` at once** |
| older than the chain window (BTC 30 min, ETH 10, BSC/SOL 5, LTC 20, NEAR 2) | red `GHOST_CREDIT` |

The "already withdrawing" path is what makes detection fast: someone who mints from nothing has to move it out quickly. Ghost credits stay red for 24 hours unless resolved.

## Check 3: flow anomalies (`checks/anomaly.ts`)

Four independent signals per bridged asset:

- **OUTFLOW_SPIKE**: last-60-minute withdrawals vs completed hourly buckets over up to 30 days (min 24 h). `z = (current − mean) / max(sd, 25% of mean, $10K)`; fires at z ≥ 4.
- **HOT_WALLET_DRAIN**: a hot wallet's latest balance ≥ 30% below its 15-minute peak.
- **FRESH_ACCOUNT_EXIT**: ≥ $50K withdrawn in the last hour by accounts younger than 24 h, counting only withdrawals ≥ $10K. Account age comes from collector data, or from first sight once the engine has watched for longer than 24 h (so restarts don't flag everyone).
- **MINT_THEN_EXIT**: a withdrawal ≥ $25K where the same account was credited ≥ 80% of it on a different chain in the 10 minutes before.

**Two-signal rule**: one signal is amber however extreme; red needs two. The spec made z > 6 red on its own. The whale replay shows the problem: three legitimate $650K withdrawals push the hourly outflow far past the baseline and would close three routes for an hour, although every dollar was backed. Attacks trip several signals at once; the October replay trips four.

## Check 4: solver concentration (`checks/concentration.ts`)

Over 24 hours of settled fills per route, by USD volume:

```
HHI = Σ (share_in_percent)²      0 … 10,000, computed in integer basis points
```

| Measure | Status |
|---|---|
| < 8 fills | green with `LOW_ACTIVITY` (informational) |
| HHI < 1,500 and top solver < 40% | green |
| HHI 1,500–2,500 or top 40–70% | amber `SOLVER_CONCENTRATED` |
| HHI > 2,500 or top > 70% | red `SINGLE_SOLVER_ROUTE` |

Solvers are identified from `intents.near` DIP-4 `token_diff` events: in a settled swap the user's diff is mirrored by one or more counterparties, and each fill is split across them by how much of the user's input they took.

## Check 5: chain health and contagion (`checks/chain.ts`)

| Signal | Amber | Red |
|---|---|---|
| Seconds since last block | NEAR 30, BTC 3,600, ETH 120, BSC/SOL 60, LTC 1,500 | NEAR 120, BTC 7,200, ETH 600, BSC/SOL 300, LTC 3,600 |
| Reorg depth | | NEAR 1, BTC 2, ETH 3, BSC 4, LTC 3, SOL 32 |
| Finality lag (ETH) | > 96 blocks | |
| Security advisory | amber advisory | red advisory |
| Stablecoin price | ≥ 1% off $1 | ≥ 3% off $1 |
| No chain data for 5 min | | unknown |

Bitcoin thresholds respect Poisson block times: an hour without a block happens a few times a month and must not page anyone.

**Contagion**: a route depends on its source chain, destination chain and NEAR. It inherits the worst of them, and the report lists the chains in `contagion` and `contagionMap`.

## Scoring and hysteresis (`scorer.ts`)

- **Status** = worst of all components (red > unknown > amber > green). Missing configuration for an asset or chain makes the route unknown with `NO_DATA`.
- **Score** = 100 minus the largest penalty in each category, capped per category (backing 40, ghost 40, anomaly 25, concentration 15, chain + depeg 30), then capped by status (red ≤ 39, unknown ≤ 49, amber ≤ 79).
- **Hysteresis**: escalation is instant. Recovery needs 3 consecutive better minutes and steps one level at a time: red → amber → green, unknown → amber → green. While held, `HYSTERESIS_HOLD` is added to the reasons.
- **Reasons** are ordered most severe first and capped at 16 so they fit on-chain.

## Safe size (`capacity.ts`)

Each verdict carries `capacity_usd`, the most (whole dollars) that should move through the route in one swap right now. Watchers sign it as part of the attestation, so it can't be inflated after signing, and the contract enforces it in `check_intent`.

- **Payout liquidity.** For a bridged destination asset, withdrawals are paid from hot wallets. One swap should need at most half of what they hold (`PAYOUT_SHARE = 0.5`); more waits on a cold-wallet refill, or during an attack on money that is already gone.
- **Demonstrated solver depth.** The largest fill each solver completed on the route in the last 24 hours, summed over the three largest. Swaps above it lean on inventory nobody has shown, which is the condition liquidity-exhaustion attacks exploit ([arXiv 2602.17805](https://arxiv.org/html/2602.17805v1)). Needs at least 8 fills, like the concentration check.
- The safe size is the tighter of the two, or $10,000 when neither has data. Caution halves it. Red and unknown are always 0, and the contract rejects a red or unknown verdict that claims otherwise.
- Rounded down to $100 steps under $10K, $1K under $100K and $10K above, so independent watchers agree and the number doesn't flicker.

**Pre-flight** (`preflight()`) turns route states into one decision for "move $X from A to B": **go** when the route is usable and the amount fits; **reroute** when it is blocked or too small and another usable route into the same token can take the whole amount, preferring one that keeps the token you hold; **reduce** (split into `ceil(amount / safe size)` swaps) when the route is fine but small and nothing bigger exists; **wait** otherwise. The status app's "Check a swap" panel and the MCP server's `check_swap` use it, and `check_swap` only says go when the contract's `check_intent` also allows it.

## Explanations

The explainer never decides status. It reads the signed verdict, extracts figures (backing %, unbacked value, outflow multiple, HHI, chain), and writes one or two sentences. With a NEAR AI key it asks the model, then rejects any answer that starts with the wrong status emoji, mentions another status, runs past 300 characters, or contains a number not present in the facts; on rejection or error it uses the deterministic template. Templates exist in English, French and Spanish.

## Falling backing

Above 100%, the ratio dips for a few minutes after every large withdrawal: the tokens are burned on NEAR first and
paid out of custody after. So "backing falling fast" (a drop of 0.2 points or more within 15 minutes) raises caution
only when the cushion above 100% is smaller than five such drops (`backing.cushionDrops`). At 107% a 0.3-point dip is
noise; at 100.8% a 0.5-point dip is heading for the line. Below 100% every fast drop counts.

The drop is measured from where the ratio has been sitting over those 15 minutes (the lower median of the earlier
readings), not from its single highest reading. A withdrawal burned on NEAR before it is paid out, or a deposit that
lands before it is credited, lifts the ratio for a reading or two; its return to normal is not a fall. Live on
mainnet this was SOL at 101.6% briefly reading 102%, which the old peak-based rule turned into ten minutes of
caution. A real drain still falls below the median and is caught.

The usual level is the lower of the 15-minute median and the 2-hour median. On a pool bridge like HOT, a large
withdrawal is burned on NEAR and collected on the home chain whenever the user gets to it, sometimes an hour later.
Until then the ratio sits higher; when it is collected the ratio returns to where it sat for hours. Seen live on
BSC USDT at 100.08%: the 15-minute median alone called that return "falling fast". A drain falls below both medians.

## What users are owed

A bridge token's total supply on NEAR can include tokens the bridge holds itself: PoA mints to its own account
(`omft.near`) before handing a deposit on, and SOL's token sends withdrawals to a bridge account instead of burning
them. Nobody is owed those. The custody finder lists the bridge's own accounts from its transactions and subtracts
their balances; the watchers subtract the same accounts (`live.assets[...].issuerAccounts`). If one of those
balances can't be read, the round's supply reads as unavailable (unverified) rather than overstated.


## Partly verified

Sometimes the finder can identify a bridge's whole treasury, but the treasury holds less than users are owed. On
mainnet in November 2026 this was the PoA bridge's Bitcoin (97.47%, 2.21 BTC short) and Litecoin (99.4%, 162.6 LTC
short). NEAR's own description of the PoA bridge says it keeps one treasury per supported chain and consolidates
every deposit there. The finder found exactly that: one wallet receives every swept deposit and pays every
withdrawal. So the missing part is not explained by a second wallet we failed to find, and Watchtower can't prove it.

NEAR Intents also publishes the wallets it holds funds in
([treasury addresses](https://docs.near-intents.org/security-compliance/treasury-addresses)). The finder checks every
listed wallet for the asset's chain (`OFFICIAL_TREASURIES`). For Bitcoin the list names exactly one treasury,
`1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra`, the one the finder traced; the Omni Bridge change address on the same page backs a
different bridge's token and is not counted. For Litecoin it names the treasury and a separate refill wallet, which
the finder counts when it holds coins. Every verified wallet so far (Ethereum, BSC, Bitcoin, Litecoin) matches the list.

Such an asset is **partly verified**. Its routes are never green: the backing check reports `BACKING_PARTIAL`, the
route reads unverified, and `is_safe` returns false. What the check still does every round is watch the shortfall,
meaning what users are owed minus what the treasury holds, in coin units. It goes red (`BACKING_GAP_GROWN`) if the
shortfall grows past its measured range. If the bridge ever covers it in full, the asset is judged normally again.

`npm run custody -- --history` only proposes it when every test passes:

| Test | Why |
|---|---|
| Coverage at least 90% | Below that, a missing wallet is likelier than a steady shortfall |
| At least 10 withdrawals traced to their payer | Shows which wallet is the treasury |
| No other wallet holds coins | The history follows only the treasury |
| At most 0.5% of what users withdrew went to addresses no NEAR withdrawal in the window named (listed) | A payout for a withdrawal made just before the window has no match inside it; a real leak also moves the shortfall, which the last test catches |
| Paid and withdrawn agree within 1% | The treasury pays what NEAR burns, no more |
| At least 24 hours and 50 withdrawals of history | Enough to see normal behaviour |
| Usual shortfall in the first fifth of the window equals the last fifth (within 10% of itself + 0.1% of what is owed) | It isn't growing |

The finder works the shortfall back through the window, from NEAR's mints and burns and the treasury's own
transactions, as a step function. The **usual shortfall** is its time-weighted median. A deposit credited on NEAR
before its coins are swept into the treasury raises the shortfall for a while; the finder records the biggest such
raise and the longest. The watchers then go red:

- at once, when the shortfall exceeds the usual level by more than 1.5× the biggest raise seen (and at least 0.1% of
  what is owed);
- or when it stays above the usual level plus 0.05% of what is owed for longer than 1.5× the longest raise seen
  (and at least 30 minutes): a loss smaller than a big deposit still shows, because it never comes back down.

Every number comes from the run that applied it (`npm run custody:apply -- --partial --history`) and is stored with
the date it was measured. Re-run it to re-measure.
