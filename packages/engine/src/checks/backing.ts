import type { AssetKey, ComponentResult } from "@watchtower/core";
import { ratioPpm, withSubject } from "@watchtower/core";
import { component, usd, type Ctx } from "../context.ts";

/**
 * Check 1: proof of backing.
 *
 *   backing = custody_on_home_chain / (credited_on_NEAR + pending_withdrawals + in_flight_deposits)
 *
 * In-flight deposits (seen on the home chain, not yet credited) already sit in custody and are
 * owed to users, so they are a liability; pending withdrawals (burned on NEAR, not yet paid out)
 * also still sit in custody and are owed. Counting both on the liability side keeps the ratio at
 * ~100% during normal settlement instead of oscillating.
 */
export function checkBacking(ctx: Ctx, asset: AssetKey): ComponentResult {
  const c = component("backing", asset);
  const { cfg, state, asOfMs } = ctx;
  const supply = state.supply[asset];
  const custody = state.custody[asset];

  if (!supply || asOfMs - supply.atMs > cfg.freshness.supplyMs) {
    c.status = "unknown";
    c.reasons.push(withSubject("SUPPLY_DATA_STALE", asset));
    c.metrics.supply_age_s = supply ? Math.floor((asOfMs - supply.atMs) / 1000) : -1;
  }
  if (state.custodyConfigured && !state.custodyConfigured.includes(asset)) {
    // Not a read failure: nobody has told the watcher where this bridge keeps its coins.
    c.status = "unknown";
    c.reasons.push(withSubject("CUSTODY_NOT_CONFIGURED", asset));
  } else if (!custody || asOfMs - custody.atMs > cfg.freshness.custodyMs) {
    c.status = "unknown";
    c.reasons.push(withSubject("CUSTODY_DATA_STALE", asset));
    c.metrics.custody_age_s = custody ? Math.floor((asOfMs - custody.atMs) / 1000) : -1;
  }
  if (!supply || !custody || c.status === "unknown") {
    c.penalty = 20;
    return c;
  }

  let inFlight = 0n;
  for (const d of state.deposits) if (d.ev.asset === asset && !d.matchedCreditId) inFlight += d.ev.amount;

  const liabilities = supply.credited + supply.pendingWithdrawals + inFlight;
  const ppm = ratioPpm(custody.balance, liabilities);
  c.metrics.custody = custody.balance.toString();
  c.metrics.credited = supply.credited.toString();
  c.metrics.pending_withdrawals = supply.pendingWithdrawals.toString();
  c.metrics.in_flight_deposits = inFlight.toString();
  if (ppm === null) {
    c.metrics.backing_ppm = -1; // nothing credited: trivially backed
    return c;
  }
  c.metrics.backing_ppm = ppm;
  const deficit = liabilities > custody.balance ? liabilities - custody.balance : 0n;
  c.metrics.deficit = deficit.toString();
  c.metrics.deficit_usd_cents = usd(ctx, asset, deficit).toString();

  // Partly verified: the custody we know covers a measured part of what is owed. Never green
  // while short; red when the shortfall grows past its measured range, or stays raised longer
  // than a deposit waiting to be swept ever kept it raised. Fully covered again: judged normally.
  const partial = state.partialBacking?.[asset];
  if (partial && deficit > 0n) {
    const raised = (state.gapRaisedSince ??= {});
    c.metrics.baseline_gap = partial.baselineGap.toString();
    c.metrics.partial_since_ms = partial.sinceMs;
    if (deficit > partial.baselineGap + partial.smallGap) raised[asset] ??= asOfMs;
    else delete raised[asset];
    const raisedFor = raised[asset] !== undefined ? asOfMs - raised[asset]! : 0;
    c.metrics.gap_raised_s = Math.floor(raisedFor / 1000);
    if (deficit > partial.alarmGap || raisedFor > partial.persistMs) {
      c.status = "red";
      c.reasons.push(withSubject("BACKING_GAP_GROWN", asset));
      c.penalty = cfg.scorer.caps.backing;
    } else {
      c.status = "unknown";
      c.reasons.push(withSubject("BACKING_PARTIAL", asset));
      c.penalty = 20;
    }
    return c;
  }
  if (partial) delete state.gapRaisedSince?.[asset];

  // Track history for the "falling fast" signal.
  const hist = (state.backingHistory[asset] ??= []);
  if (hist.length === 0 || hist[hist.length - 1]!.atMs < asOfMs) hist.push({ atMs: asOfMs, ppm });
  const keepMs = Math.max(cfg.backing.dropWindowMs, cfg.backing.baselineWindowMs ?? 0);
  while (hist.length > 0 && hist[0]!.atMs < asOfMs - keepMs) hist.shift();
  // Measure the fall from where the ratio has been sitting, not from its highest reading: a
  // withdrawal burned on NEAR before it is paid out, or a deposit landing before it is credited,
  // lifts the ratio for a while, and its return to normal is not a fall. The lower median of the
  // earlier readings ignores such spikes; taking the lower of the 15-minute and the 2-hour
  // medians ignores long ones too (a big withdrawal collected an hour later). A real drain falls
  // below both.
  const lowerMedian = (fromMs: number) => {
    const xs = hist.filter((h) => h.atMs < asOfMs && h.atMs >= fromMs).map((h) => h.ppm).sort((x, y) => x - y);
    return xs.length ? xs[Math.floor((xs.length - 1) / 2)]! : undefined;
  };
  const recent = lowerMedian(asOfMs - cfg.backing.dropWindowMs);
  const usual = lowerMedian(asOfMs - (cfg.backing.baselineWindowMs ?? cfg.backing.dropWindowMs));
  const baseline = recent === undefined ? ppm : usual === undefined ? recent : Math.min(recent, usual);
  const drop = Math.max(0, baseline - ppm);
  c.metrics.drop_ppm = drop;
  c.metrics.baseline_ppm = baseline;

  // A fall only matters when it heads for the line. Above 100%, every large withdrawal dips the
  // ratio for a few minutes (burned on NEAR first, paid out from custody after), so with a wide
  // cushion a dip is noise: caution only if a few more drops like this one would cross 100%.
  const cushion = ppm - cfg.backing.greenPpm;
  const fallingFast = drop >= cfg.backing.dropFastPpm && (cushion < 0 || cushion < drop * cfg.backing.cushionDrops);
  c.metrics.cushion_ppm = cushion;
  if (ppm < cfg.backing.amberPpm) {
    c.status = "red";
    c.reasons.push(withSubject("BACKING_BELOW_THRESHOLD", asset));
    // 20 points for crossing the line, up to 40 as the hole deepens (2 points per 0.1% missing).
    c.penalty = Math.min(cfg.scorer.caps.backing, 20 + Math.floor((cfg.backing.greenPpm - ppm) / 500));
  } else if (ppm < cfg.backing.greenPpm) {
    c.status = fallingFast ? "red" : "amber";
    c.reasons.push(withSubject(fallingFast ? "BACKING_DROP_FAST" : "BACKING_TOLERANCE", asset));
    c.penalty = fallingFast ? 30 : 10;
  } else if (fallingFast) {
    c.status = "amber";
    c.reasons.push(withSubject("BACKING_DROP_FAST", asset));
    c.penalty = 8;
  }
  if (fallingFast && c.status === "red" && !c.reasons.some((r) => r.startsWith("BACKING_DROP_FAST"))) {
    c.reasons.push(withSubject("BACKING_DROP_FAST", asset));
  }
  return c;
}
