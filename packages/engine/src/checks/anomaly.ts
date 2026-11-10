import type { AssetKey, ComponentResult } from "@watchtower/core";
import { withSubject } from "@watchtower/core";
import { component, usd, type Ctx } from "../context.ts";

const HOUR = 3_600_000;

/**
 * Check 3: flow anomalies. Four independent signals:
 *   OUTFLOW_SPIKE      last-hour withdrawals vs a 30-day hourly baseline (z-score)
 *   HOT_WALLET_DRAIN   a hot wallet lost a big share of its balance in minutes
 *   FRESH_ACCOUNT_EXIT large withdrawals from accounts younger than a day
 *   MINT_THEN_EXIT     credited on one chain, pulled out to another within minutes
 *
 * Two-signal rule: any single signal is amber, however extreme; red needs two independent
 * signals. A whale withdrawing $2M legitimately trips OUTFLOW_SPIKE alone. An attacker draining a
 * bridge trips three or four at once. This keeps false alarms off is_safe without slowing real
 * detection (see the "whale-day" replay scenario). Extreme values are still reported in metrics.
 */
export function checkAnomaly(ctx: Ctx, asset: AssetKey): ComponentResult {
  const c = component("anomaly", asset);
  const { cfg, state, asOfMs } = ctx;
  const a = cfg.anomaly;
  let signals = 0;
  let strong = false;

  // --- Outflow velocity --------------------------------------------------------------------
  let cur = 0n;
  for (const w of state.withdrawals) if (w.asset === asset && w.atMs > asOfMs - HOUR) cur += usd(ctx, asset, w.amount);
  const currentHour = Math.floor(asOfMs / HOUR) * HOUR;
  const since = state.outflowSinceMs[asset];
  const buckets = state.outflowHourly[asset] ?? {};
  const hours = since === undefined ? 0 : Math.min(a.baselineMaxHours, Math.floor((currentHour - since) / HOUR));
  c.metrics.outflow_1h_usd_cents = cur.toString();
  c.metrics.baseline_hours = hours;
  if (hours < a.baselineMinHours) {
    c.reasons.push(withSubject("BASELINE_WARMING", asset));
  } else {
    let sum = 0;
    const vals: number[] = [];
    for (let h = 1; h <= hours; h++) {
      const v = Number(buckets[String(currentHour - h * HOUR)] ?? 0n);
      vals.push(v);
      sum += v;
    }
    const mean = sum / hours;
    let varSum = 0;
    for (const v of vals) varSum += (v - mean) * (v - mean);
    const sd = Math.sqrt(varSum / hours);
    const floor = Math.max(Number(a.sdFloorCents), (mean * a.sdFloorMeanPpm) / 1_000_000);
    const z100 = Math.round(((Number(cur) - mean) / Math.max(sd, floor)) * 100);
    c.metrics.baseline_mean_usd_cents = Math.round(mean);
    c.metrics.outflow_z100 = z100;
    if (z100 >= a.zAmber100) {
      signals++;
      if (z100 >= a.zStrong100) strong = true;
      c.reasons.push(withSubject("OUTFLOW_SPIKE", asset));
    }
  }

  // --- Hot wallet drain --------------------------------------------------------------------
  let worstDrain = 0;
  for (const [key, series] of Object.entries(state.hotWallets)) {
    if (!key.startsWith(`${asset}|`) || series.length === 0) continue;
    const recent = series.filter((p) => p.atMs >= asOfMs - a.drainWindowMs);
    if (recent.length === 0) continue;
    const peak = recent.reduce((m, p) => (p.balance > m ? p.balance : m), 0n);
    const last = recent[recent.length - 1]!.balance;
    if (peak > 0n && last < peak) {
      const dropPpm = Number(((peak - last) * 1_000_000n) / peak);
      if (dropPpm > worstDrain) worstDrain = dropPpm;
      if (dropPpm >= a.drainPpm) c.evidence.push({ kind: "address", ref: key.split("|")[1]!, label: `hot wallet -${(dropPpm / 10_000).toFixed(1)}% in ${a.drainWindowMs / 60_000}m` });
    }
  }
  c.metrics.hot_wallet_drop_ppm = worstDrain;
  if (worstDrain >= a.drainPpm) {
    signals++;
    if (worstDrain >= a.drainStrongPpm) strong = true;
    c.reasons.push(withSubject("HOT_WALLET_DRAIN", asset));
  }

  // --- Fresh accounts withdrawing ------------------------------------------------------------
  let freshSum = 0n;
  for (const w of state.withdrawals) {
    if (w.asset !== asset || w.atMs <= asOfMs - HOUR) continue;
    const born = accountBirth(ctx, w.account);
    if (born === undefined || w.atMs - born > a.freshAccountMs) continue;
    const v = usd(ctx, asset, w.amount);
    if (v >= a.freshMinTxCents) freshSum += v;
  }
  c.metrics.fresh_exit_usd_cents = freshSum.toString();
  if (freshSum >= a.freshSumCents) {
    signals++;
    c.reasons.push(withSubject("FRESH_ACCOUNT_EXIT", asset));
  }

  // --- Mint then exit ----------------------------------------------------------------------
  let mintExit = 0n;
  let mintExitCount = 0;
  for (const w of state.withdrawals) {
    if (w.asset !== asset || w.atMs <= asOfMs - HOUR) continue;
    const wv = usd(ctx, asset, w.amount);
    if (wv < a.mintExitMinCents) continue;
    let credited = 0n;
    for (const cs of state.credits) {
      const cr = cs.ev;
      if (cr.account !== w.account || cr.atMs > w.atMs || cr.atMs < w.atMs - a.mintExitWindowMs) continue;
      const crChain = ctx.assets.get(cr.asset)?.chain;
      if (crChain === w.destChain) continue;
      credited += usd(ctx, cr.asset, cr.amount);
    }
    if (credited * 1_000_000n >= wv * BigInt(a.mintExitMatchPpm)) {
      mintExit += wv;
      mintExitCount++;
      c.evidence.push({ kind: "near_tx", ref: w.nearTx, label: `withdrawal ${w.id} minutes after credit` });
    }
  }
  c.metrics.mint_exit_usd_cents = mintExit.toString();
  c.metrics.mint_exit_count = mintExitCount;
  if (mintExitCount > 0) {
    signals++;
    c.reasons.push(withSubject("MINT_THEN_EXIT", asset));
  }

  c.metrics.signals = signals;
  c.metrics.extreme = strong ? 1 : 0;
  if (signals >= 2) {
    c.status = "red";
    c.penalty = cfg.scorer.caps.anomaly;
  } else if (signals === 1) {
    c.status = "amber";
    c.penalty = 10;
  }
  c.evidence = c.evidence.slice(0, 10);
  return c;
}

/** Creation time if known; otherwise first-seen, but only once we've watched long enough for it to mean anything. */
function accountBirth(ctx: Ctx, account: string): number | undefined {
  const explicit = ctx.state.accounts[account];
  if (explicit !== undefined) return explicit;
  const seen = ctx.state.firstSeen[account];
  if (seen === undefined) return undefined;
  return seen - ctx.state.firstIngestMs >= ctx.cfg.anomaly.freshAccountMs ? seen : undefined;
}
