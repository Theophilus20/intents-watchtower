import type { AssetKey, ComponentResult, RouteId, Status } from "@watchtower/core";
import { parseRoute } from "@watchtower/core";
import { isBridged, usd, type Ctx } from "./context.ts";

/**
 * Safe size ("capacity"): how much can move through a route right now.
 *
 *   payout   For a bridged destination asset, withdrawals are paid from hot wallets. A single swap
 *            should not need more than half of what those wallets hold, or it waits on a cold-wallet
 *            refill (or, during an attack, on money that is already gone).
 *   solvers  Recent proof of liquidity: the largest fill each solver completed in the last 24h,
 *            summed over the three biggest. Swaps above this lean on solver inventory nobody has
 *            demonstrated, which is also how liquidity-exhaustion attacks on intents work.
 *   status   Unsafe or unverified routes have no safe size; caution halves it.
 *
 * Everything is integer dollars so watchers produce identical values and the contract can enforce it.
 */
export const DEFAULT_CAPACITY_USD = 10_000;
const PAYOUT_SHARE = 0.5;

export function payoutLiquidityUsd(ctx: Ctx, asset: AssetKey): number | null {
  let cents = 0n;
  let seen = false;
  for (const [key, series] of Object.entries(ctx.state.hotWallets)) {
    if (!key.startsWith(`${asset}|`) || series.length === 0) continue;
    cents += usd(ctx, asset, series[series.length - 1]!.balance);
    seen = true;
  }
  return seen ? Number(cents / 100n) : null;
}

export function solverDepthUsd(ctx: Ctx, route: RouteId): number | null {
  const maxBySolver = new Map<string, bigint>();
  let fills = 0;
  for (const f of ctx.state.fills) {
    if (f.route !== route || f.atMs <= ctx.asOfMs - ctx.cfg.concentration.windowMs) continue;
    fills++;
    if ((maxBySolver.get(f.solver) ?? 0n) < f.usdCents) maxBySolver.set(f.solver, f.usdCents);
  }
  if (fills < ctx.cfg.concentration.minFills) return null;
  const top = [...maxBySolver.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)).slice(0, 3);
  return Number(top.reduce((s, v) => s + v, 0n) / 100n);
}

/** Round down to a readable, stable figure: $100 steps under $10K, $1K under $100K, $10K above. */
export function roundDown(v: number): number {
  if (v <= 0) return 0;
  const step = v < 10_000 ? 100 : v < 100_000 ? 1_000 : 10_000;
  return Math.floor(v / step) * step;
}

export function routeCapacity(ctx: Ctx, route: RouteId, status: Status): { capacityUsd: number; capacityBasis: "payout" | "solvers" | "default" | "blocked"; metrics: Record<string, number> } {
  const r = parseRoute(route);
  const metrics: Record<string, number> = {};
  if (status === "red" || status === "unknown") return { capacityUsd: 0, capacityBasis: "blocked", metrics };

  const limits: { basis: "payout" | "solvers"; usd: number }[] = [];
  if (isBridged(ctx, r.dst)) {
    const payout = payoutLiquidityUsd(ctx, r.dst);
    if (payout !== null) {
      metrics.payout_liquidity_usd = payout;
      limits.push({ basis: "payout", usd: Math.floor(payout * PAYOUT_SHARE) });
    }
  }
  const depth = solverDepthUsd(ctx, route);
  if (depth !== null) {
    metrics.solver_depth_usd = depth;
    limits.push({ basis: "solvers", usd: depth });
  }
  let capacity: number;
  let basis: "payout" | "solvers" | "default";
  if (limits.length === 0) {
    capacity = DEFAULT_CAPACITY_USD;
    basis = "default";
  } else {
    const tightest = limits.reduce((a, b) => (b.usd < a.usd ? b : a));
    capacity = tightest.usd;
    basis = tightest.basis;
  }
  if (status === "amber") capacity = Math.floor(capacity / 2);
  return { capacityUsd: roundDown(capacity), capacityBasis: basis, metrics };
}

// ---------------------------------------------------------------------------------------------
// Pre-flight: one answer for "I want to move $X from A to B".
// ---------------------------------------------------------------------------------------------

export type Decision = "go" | "reduce" | "reroute" | "wait";

export interface RouteState {
  route: RouteId;
  status: Status;
  score: number;
  capacityUsd: number;
  reasons: string[];
}

export interface Preflight {
  decision: Decision;
  route: RouteId;
  amountUsd: number;
  status: Status;
  capacityUsd: number;
  reasons: string[];
  /** A better route when the requested one is blocked or too small. */
  alternative?: RouteState;
  /** "same_source": same token you hold, delivered on another chain. "same_destination": fund from another token. */
  alternativeKind?: "same_source" | "same_destination";
  /** How many equal parts the amount would need to fit the safe size. */
  splitInto?: number;
}

/** Same destination asset, or same source asset into the same token on another chain. */
export function alternativesFor(route: RouteId, all: RouteState[]): RouteState[] {
  const r = parseRoute(route);
  return all.filter((x) => {
    if (x.route === route) return false;
    const p = parseRoute(x.route);
    return p.dst === r.dst || (p.src === r.src && p.dstSymbol === r.dstSymbol);
  });
}

export function preflight(route: RouteId, amountUsd: number, all: RouteState[], opts: { allowAmber?: boolean } = {}): Preflight {
  const me = all.find((x) => x.route === route);
  if (!me) return { decision: "wait", route, amountUsd, status: "unknown", capacityUsd: 0, reasons: ["NO_DATA"] };
  const usable = (x: RouteState) => x.status === "green" || (x.status === "amber" && opts.allowAmber !== false);
  const base = { route, amountUsd, status: me.status, capacityUsd: me.capacityUsd, reasons: me.reasons };
  const r = parseRoute(route);
  const sameSource = (x: RouteState) => parseRoute(x.route).src === r.src;
  const better = alternativesFor(route, all)
    .filter((x) => usable(x) && x.capacityUsd >= amountUsd)
    // Keeping the user's own token beats asking them to fund from something else.
    .sort((a, b) => Number(sameSource(b)) - Number(sameSource(a)) || b.score - a.score || b.capacityUsd - a.capacityUsd)[0];
  const reroute = (x: RouteState): Preflight => ({ ...base, decision: "reroute", alternative: x, alternativeKind: sameSource(x) ? "same_source" : "same_destination" });
  if (!usable(me) || me.capacityUsd === 0) return better ? reroute(better) : { ...base, decision: "wait" };
  if (amountUsd <= me.capacityUsd) return { ...base, decision: "go" };
  if (better) return reroute(better);
  return { ...base, decision: "reduce", splitInto: Math.ceil(amountUsd / Math.max(1, me.capacityUsd)) };
}

export type { ComponentResult };
