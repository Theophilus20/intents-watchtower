import type { CreditEvent, DepositEvent } from "@watchtower/core";
import { fromUsdCents } from "@watchtower/core";
import { chainOf, type Ctx } from "./context.ts";
import type { CreditState, DepositState } from "./state.ts";

/**
 * Ghost-credit matcher.
 *
 * Every credit on NEAR must be paired with a real deposit on its home chain. Pairing rules:
 *  1. Same asset.
 *  2. If the bridge recorded the source tx on the credit, it must be exactly that tx.
 *  3. If both sides name a NEAR account, the accounts must agree.
 *  4. credit <= deposit, and the difference fits the bridge fee allowance.
 *  5. The deposit is no older than the lookback and no later than the chain's observer window.
 * Among candidates the best is: exact tx ref, then smallest amount gap, then closest in time,
 * then lowest id (so every watcher pairs identically).
 */
export function canMatch(ctx: Ctx, c: CreditEvent, d: DepositEvent): boolean {
  if (c.asset !== d.asset) return false;
  if (c.sourceTxRef && c.sourceTxRef !== d.sourceTx) return false;
  if (c.account && d.account && c.account !== d.account) return false;
  if (c.amount > d.amount) return false;
  const fee = d.amount - c.amount;
  const asset = ctx.assets.get(c.asset);
  const price = ctx.state.prices[c.asset]?.priceMicroUsd ?? 0n;
  const absAllowance = asset ? fromUsdCents(ctx.cfg.ghost.feeAbsCents, asset.decimals, price) : 0n;
  const pctAllowance = (d.amount * BigInt(ctx.cfg.ghost.feeTolPpm)) / 1_000_000n;
  if (fee > (absAllowance > pctAllowance ? absAllowance : pctAllowance)) return false;
  const windowMs = (chainOf(ctx, c.asset)?.confirmWindowSec ?? 600) * 1000;
  if (d.atMs < c.atMs - ctx.cfg.ghost.depositLookbackMs) return false;
  if (d.atMs > c.atMs + windowMs) return false;
  return true;
}

function rank(c: CreditEvent, d: DepositEvent): [number, bigint, number, string] {
  return [c.sourceTxRef === d.sourceTx ? 0 : 1, d.amount - c.amount, Math.abs(d.atMs - c.atMs), d.id];
}

function better(a: [number, bigint, number, string], b: [number, bigint, number, string]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  if (a[2] !== b[2]) return a[2] < b[2];
  return a[3] < b[3];
}

export function tryMatchCredit(ctx: Ctx, cs: CreditState, pool: DepositState[]): boolean {
  let best: DepositState | undefined;
  let bestRank: [number, bigint, number, string] | undefined;
  for (const ds of pool) {
    if (ds.matchedCreditId || !canMatch(ctx, cs.ev, ds.ev)) continue;
    const r = rank(cs.ev, ds.ev);
    if (!bestRank || better(r, bestRank)) {
      best = ds;
      bestRank = r;
    }
  }
  if (!best) return false;
  best.matchedCreditId = cs.ev.id;
  cs.matchedDepositId = best.ev.id;
  cs.matchedAtMs = ctx.asOfMs;
  return true;
}

export function tryMatchDeposit(ctx: Ctx, ds: DepositState, pool: CreditState[]): boolean {
  let best: CreditState | undefined;
  let bestRank: [number, bigint, number, string] | undefined;
  for (const cs of pool) {
    if (cs.matchedDepositId || !canMatch(ctx, cs.ev, ds.ev)) continue;
    const r = rank(cs.ev, ds.ev);
    // Prefer the oldest open credit when ranks tie on amount/time: it has waited longest.
    if (!bestRank || better(r, bestRank) || (r[1] === bestRank[1] && r[0] === bestRank[0] && cs.ev.atMs < best!.ev.atMs)) {
      best = cs;
      bestRank = r;
    }
  }
  if (!best) return false;
  best.matchedDepositId = ds.ev.id;
  best.matchedAtMs = ctx.asOfMs;
  ds.matchedCreditId = best.ev.id;
  return true;
}

export function byTimeThenId<T extends { atMs: number; id: string }>(a: T, b: T): number {
  return a.atMs - b.atMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
