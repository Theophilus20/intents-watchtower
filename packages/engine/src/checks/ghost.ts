import type { AssetKey, ComponentResult } from "@watchtower/core";
import { withSubject } from "@watchtower/core";
import { chainOf, component, usd, type Ctx } from "../context.ts";

/**
 * Check 2: ghost credits — balance credited on NEAR with no deposit behind it.
 *
 * An unmatched credit is judged by age:
 *   age <= grace            -> not judged yet (observer lag)
 *   grace < age <= window   -> amber if large, RED at once if its account is already withdrawing
 *   age > window            -> RED: the deposit never arrived
 * The "already withdrawing" path is what makes this fast: an attacker who mints from nothing
 * has to move the money out quickly, and that is exactly the pattern we refuse to wait on.
 */
export function checkGhost(ctx: Ctx, asset: AssetKey): ComponentResult {
  const c = component("ghost", asset);
  const { cfg, state, asOfMs } = ctx;
  const windowMs = (chainOf(ctx, asset)?.confirmWindowSec ?? 600) * 1000;

  // Without a view of this asset's deposits, every credit would look unmatched: don't judge.
  const fed = state.depositFeeds?.[asset];
  if (state.depositFeedsDeclared && (fed === undefined || asOfMs - fed > windowMs)) {
    c.reasons.push(withSubject("GHOST_UNCHECKED", asset));
    return c;
  }

  let ghosts = 0, exiting = 0, pending = 0;
  let ghostValue = 0n, pendingValue = 0n, oldestAge = 0;
  /** account -> USD withdrawn since its earliest exiting unmatched credit (counted once per account) */
  const exitByAccount = new Map<string, { since: number; value: bigint }>();

  for (const cs of state.credits) {
    const cr = cs.ev;
    if (cr.asset !== asset || cs.matchedDepositId) continue;
    const age = asOfMs - cr.atMs;
    if (age <= cfg.ghost.graceMs) continue;
    const value = usd(ctx, asset, cr.amount);
    oldestAge = Math.max(oldestAge, age);

    // How much has this account pulled out since the credit (any asset, valued in USD)?
    let withdrawn = 0n;
    let sameAssetWithdrawn = 0n;
    for (const w of state.withdrawals) {
      if (w.account !== cr.account || w.atMs < cr.atMs) continue;
      withdrawn += usd(ctx, w.asset, w.amount);
      if (w.asset === asset) sameAssetWithdrawn += w.amount;
    }
    const exitedByValue = value > 0n && withdrawn * 1_000_000n >= value * BigInt(cfg.ghost.exitFractionPpm);
    const exitedByAmount = sameAssetWithdrawn * 1_000_000n >= cr.amount * BigInt(cfg.ghost.exitFractionPpm);
    const isExiting = exitedByValue || exitedByAmount;

    if (age > windowMs) {
      ghosts++;
      ghostValue += value;
      c.evidence.push({ kind: "near_tx", ref: cr.nearTx, label: `unmatched credit ${cr.id}` });
    }
    if (isExiting) {
      exiting++;
      const prev = exitByAccount.get(cr.account);
      if (!prev || cr.atMs < prev.since) exitByAccount.set(cr.account, { since: cr.atMs, value: withdrawn });
      if (age <= windowMs) c.evidence.push({ kind: "near_tx", ref: cr.nearTx, label: `credit ${cr.id} withdrawn before any deposit` });
    } else if (age <= windowMs && value >= cfg.ghost.pendingAmberCents) {
      pending++;
      pendingValue += value;
    }
  }

  const exitValue = [...exitByAccount.values()].reduce((s, x) => s + x.value, 0n);
  c.metrics.ghost_count = ghosts;
  c.metrics.ghost_usd_cents = ghostValue.toString();
  c.metrics.exiting_count = exiting;
  c.metrics.exited_usd_cents = exitValue.toString();
  c.metrics.pending_count = pending;
  c.metrics.pending_usd_cents = pendingValue.toString();
  c.metrics.oldest_unmatched_age_s = Math.floor(oldestAge / 1000);

  if (exiting > 0) {
    c.status = "red";
    c.reasons.push(withSubject("GHOST_CREDIT_WITHDRAWN", asset));
    c.penalty = cfg.scorer.caps.ghost;
  }
  if (ghosts > 0) {
    c.status = "red";
    c.reasons.push(withSubject("GHOST_CREDIT", asset));
    c.penalty = cfg.scorer.caps.ghost;
  }
  if (c.status === "green" && pending > 0) {
    c.status = "amber";
    c.reasons.push(withSubject("GHOST_CREDIT_PENDING", asset));
    c.penalty = 15;
  }
  c.evidence = c.evidence.slice(0, 10);
  return c;
}
