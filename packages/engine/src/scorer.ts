import type { ChainId, ComponentResult, RouteId, Status } from "@watchtower/core";
import { REASONS, STATUS_RANK, reasonCode, worstStatus } from "@watchtower/core";
import type { Ctx } from "./context.ts";

export interface RawScore {
  raw: Status;
  score: number;
  reasons: string[];
  contagion: ChainId[];
}

const CATEGORY: Record<ComponentResult["check"], keyof Ctx["cfg"]["scorer"]["caps"]> = {
  backing: "backing",
  ghost: "ghost",
  anomaly: "anomaly",
  concentration: "concentration",
  chain: "chain",
  depeg: "chain",
};

/** Worst-of status, capped per-category penalties, ordered reasons. */
export function scoreRoute(ctx: Ctx, comps: ComponentResult[]): RawScore {
  const caps = ctx.cfg.scorer.caps;
  const catPenalty: Record<string, number> = {};
  let raw: Status = "green";
  const reasons = new Set<string>();
  const contagion = new Set<ChainId>();
  for (const c of comps) {
    raw = worstStatus(raw, c.status);
    const cat = CATEGORY[c.check];
    catPenalty[cat] = Math.min(caps[cat], Math.max(catPenalty[cat] ?? 0, c.penalty));
    for (const r of c.reasons) reasons.add(r);
    if (c.check === "chain" && c.status !== "green") contagion.add(c.subject);
  }
  const score = Math.max(0, 100 - Object.values(catPenalty).reduce((a, b) => a + b, 0));
  return { raw, score, reasons: orderReasons([...reasons], ctx.cfg.scorer.maxReasons), contagion: [...contagion].sort() };
}

/** Most severe first, then alphabetical; info last. Bounded so it fits on-chain. */
export function orderReasons(reasons: string[], max: number): string[] {
  const sev = (r: string) => {
    const code = reasonCode(r);
    if (!code) return -1;
    const s = REASONS[code].severity;
    return s === "info" ? -1 : STATUS_RANK[s];
  };
  return reasons.sort((a, b) => sev(b) - sev(a) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, max);
}

/**
 * Hysteresis. Escalation is instant. Recovery needs `cleanStepsToRecover` consecutive steps
 * that are better than what is published, and steps down one level at a time:
 *   red -> amber -> green,  unknown -> amber -> green
 * Getting safer is slow; raising the alarm is immediate.
 */
export function applyHysteresis(ctx: Ctx, route: RouteId, raw: Status): { status: Status; held: boolean } {
  const mem = (ctx.state.routes[route] ??= { published: raw, cleanStreak: 0, sinceMs: ctx.asOfMs, lastEvalMs: -1 });
  if (mem.lastEvalMs === ctx.asOfMs) return { status: mem.published, held: STATUS_RANK[raw] < STATUS_RANK[mem.published] };
  mem.lastEvalMs = ctx.asOfMs;

  if (STATUS_RANK[raw] > STATUS_RANK[mem.published]) {
    mem.published = raw;
    mem.cleanStreak = 0;
    mem.sinceMs = ctx.asOfMs;
  } else if (raw === mem.published) {
    mem.cleanStreak = 0;
  } else {
    mem.cleanStreak++;
    if (mem.cleanStreak >= ctx.cfg.scorer.cleanStepsToRecover) {
      const next: Status = mem.published === "red" || mem.published === "unknown" ? (raw === "green" ? "amber" : raw) : raw;
      mem.published = next;
      mem.cleanStreak = 0;
      mem.sinceMs = ctx.asOfMs;
    }
  }
  return { status: mem.published, held: STATUS_RANK[raw] < STATUS_RANK[mem.published] };
}

/** Keep the headline score consistent with the published status. */
export function capScore(score: number, status: Status): number {
  if (status === "red") return Math.min(score, 39);
  if (status === "unknown") return Math.min(score, 49);
  if (status === "amber") return Math.min(score, 79);
  return score;
}
