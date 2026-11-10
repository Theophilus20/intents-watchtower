import type { ComponentResult, RouteId } from "@watchtower/core";
import { withSubject } from "@watchtower/core";
import { component, type Ctx } from "../context.ts";

/**
 * Check 4: solver concentration on a route over the last 24h.
 *   HHI = sum over solvers of (share in %)^2, 0..10,000 (the standard antitrust index).
 * HHI and top-solver share are both computed in integer basis points.
 */
export function checkConcentration(ctx: Ctx, route: RouteId): ComponentResult {
  const c = component("concentration", route);
  const { cfg, state, asOfMs } = ctx;
  const k = cfg.concentration;
  const bySolver = new Map<string, bigint>();
  let total = 0n;
  let fills = 0;
  for (const f of state.fills) {
    if (f.route !== route || f.atMs <= asOfMs - k.windowMs) continue;
    bySolver.set(f.solver, (bySolver.get(f.solver) ?? 0n) + f.usdCents);
    total += f.usdCents;
    fills++;
  }
  c.metrics.fills_24h = fills;
  c.metrics.solvers_24h = bySolver.size;
  c.metrics.volume_24h_usd_cents = total.toString();
  if (fills < k.minFills || total === 0n) {
    c.reasons.push(withSubject("LOW_ACTIVITY", route));
    return c;
  }
  let hhi10k = 0n; // in bp^2
  let top = 0n;
  let topSolver = "";
  for (const [solver, v] of [...bySolver.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const bp = (v * 10_000n) / total;
    hhi10k += bp * bp;
    if (v > top) {
      top = v;
      topSolver = solver;
    }
  }
  const hhi = Number(hhi10k / 10_000n);
  const topPpm = Number((top * 1_000_000n) / total);
  c.metrics.hhi = hhi;
  c.metrics.top_solver_ppm = topPpm;
  c.metrics.top_solver = topSolver;
  if (hhi > k.hhiRed || topPpm > k.topRedPpm) {
    c.status = "red";
    c.reasons.push(withSubject("SINGLE_SOLVER_ROUTE", route));
    c.penalty = cfg.scorer.caps.concentration;
  } else if (hhi >= k.hhiAmber || topPpm >= k.topAmberPpm) {
    c.status = "amber";
    c.reasons.push(withSubject("SOLVER_CONCENTRATED", route));
    c.penalty = 8;
  }
  return c;
}
