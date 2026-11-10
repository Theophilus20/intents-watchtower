import type {
  AssetKey, ComponentResult, EngineReport, ObservationBatch, RouteId, RouteVerdict, Status,
} from "@watchtower/core";
import { hashCanonical, parseRoute, routeChains, sha256Hex, toUsdCents, withSubject } from "@watchtower/core";
import { checkAnomaly } from "./checks/anomaly.ts";
import { checkBacking } from "./checks/backing.ts";
import { checkChain, checkDepeg } from "./checks/chain.ts";
import { checkConcentration } from "./checks/concentration.ts";
import { checkGhost } from "./checks/ghost.ts";
import { defaultConfig, ENGINE_VERSION, type EngineConfig } from "./config.ts";
import { isBridged, makeCtx, type Ctx } from "./context.ts";
import { byTimeThenId, tryMatchCredit, tryMatchDeposit } from "./matcher.ts";
import { applyHysteresis, capScore, orderReasons, scoreRoute } from "./scorer.ts";
import { routeCapacity } from "./capacity.ts";
import { emptyState, serializeState, deserializeState, type EngineState } from "./state.ts";

const HOUR = 3_600_000;
const RETAIN_MATCHED_MS = 2 * HOUR;

/**
 * The deterministic risk engine.
 *
 *   ingest(batch)  fold new observations into state (append-only, idempotent by event id)
 *   evaluate()     run the five checks, score every route, apply hysteresis, hash verdicts
 *
 * Two watchers that ingest the same batches in the same order produce byte-identical
 * verdicts and therefore identical report hashes. `inputsDigest` is a hash chain over every
 * batch ingested, so a published report also proves which inputs produced it.
 */
export class RiskEngine {
  readonly cfg: EngineConfig;
  state: EngineState;

  constructor(cfg: EngineConfig = defaultConfig(), state: EngineState = emptyState()) {
    this.cfg = cfg;
    this.state = state;
  }

  static restore(cfg: EngineConfig, serialized: string): RiskEngine {
    return new RiskEngine(cfg, deserializeState(serialized));
  }

  snapshot(): string {
    return serializeState(this.state);
  }

  /** Ingest then evaluate at the batch time. */
  step(batch: ObservationBatch): EngineReport {
    this.ingest(batch);
    return this.evaluate(batch.asOfMs);
  }

  ingest(batch: ObservationBatch): void {
    const s = this.state;
    if (batch.asOfMs < s.lastAsOfMs) throw new Error(`Batch time ${batch.asOfMs} is before last ingested ${s.lastAsOfMs}`);
    if (s.firstIngestMs === 0) s.firstIngestMs = batch.asOfMs;
    s.inputsDigest = sha256Hex(s.inputsDigest + hashCanonical(batch));
    const ctx = makeCtx(this.cfg, s, batch.asOfMs);
    const hourOf = (ms: number) => Math.floor(ms / HOUR) * HOUR;

    for (const a of this.cfg.assets) s.outflowSinceMs[a.key] ??= hourOf(batch.asOfMs);

    for (const o of batch.supply ?? []) if (!s.supply[o.asset] || s.supply[o.asset]!.atMs <= o.atMs) s.supply[o.asset] = o;
    for (const o of batch.custody ?? []) if (!s.custody[o.asset] || s.custody[o.asset]!.atMs <= o.atMs) s.custody[o.asset] = o;
    for (const o of batch.prices ?? []) if (!s.prices[o.asset] || s.prices[o.asset]!.atMs <= o.atMs) s.prices[o.asset] = o;
    for (const o of batch.chains ?? []) if (!s.chains[o.chain] || s.chains[o.chain]!.atMs <= o.atMs) s.chains[o.chain] = o;
    for (const a of batch.advisories ?? []) s.advisories[a.id] = a;
    if (batch.custodyConfigured) s.custodyConfigured = [...batch.custodyConfigured];
    if (batch.partialBacking) {
      s.partialBacking = Object.fromEntries(batch.partialBacking.map((p) => [p.asset, p]));
      for (const a of Object.keys(s.gapRaisedSince ?? {})) if (!s.partialBacking[a]) delete s.gapRaisedSince![a];
    }
    if (batch.depositFeeds) {
      s.depositFeedsDeclared = true;
      s.depositFeeds ??= {};
      for (const a of batch.depositFeeds) s.depositFeeds[a] = batch.asOfMs;
    }
    for (const a of batch.accounts ?? []) s.accounts[a.account] = Math.min(s.accounts[a.account] ?? a.createdAtMs, a.createdAtMs);
    for (const h of batch.outflowHistory ?? []) {
      const b = (s.outflowHourly[h.asset] ??= {});
      b[String(hourOf(h.hourStartMs))] = h.usdCents;
      s.outflowSinceMs[h.asset] = Math.min(s.outflowSinceMs[h.asset] ?? Infinity, hourOf(h.hourStartMs));
    }
    for (const h of batch.hotWallets ?? []) {
      const series = (s.hotWallets[`${h.asset}|${h.address}`] ??= []);
      if (series.length === 0 || series[series.length - 1]!.atMs < h.atMs) series.push({ atMs: h.atMs, balance: h.balance });
    }

    const seen = (ids: Iterable<string>) => new Set(ids);
    const seenCredits = seen(s.credits.map((c) => c.ev.id));
    const seenDeposits = seen(s.deposits.map((d) => d.ev.id));
    const seenWithdrawals = seen(s.withdrawals.map((w) => w.id));
    const seenFills = seen(s.fills.map((f) => f.id));
    const markSeen = (acct: string, at: number) => {
      if (s.firstSeen[acct] === undefined || s.firstSeen[acct]! > at) s.firstSeen[acct] = at;
    };

    const newDeposits = (batch.deposits ?? []).filter((d) => !seenDeposits.has(d.id)).sort(byTimeThenId);
    const newCredits = (batch.credits ?? []).filter((c) => !seenCredits.has(c.id)).sort(byTimeThenId);
    for (const d of newDeposits) s.deposits.push({ ev: d });
    for (const c of newCredits) {
      s.credits.push({ ev: c });
      markSeen(c.account, c.atMs);
    }
    for (const w of [...(batch.withdrawals ?? [])].sort(byTimeThenId)) {
      if (seenWithdrawals.has(w.id)) continue;
      s.withdrawals.push(w);
      seenWithdrawals.add(w.id);
      markSeen(w.account, w.atMs);
      const asset = ctx.assets.get(w.asset);
      const price = s.prices[w.asset]?.priceMicroUsd;
      if (asset && price) {
        const b = (s.outflowHourly[w.asset] ??= {});
        const k = String(hourOf(w.atMs));
        b[k] = (b[k] ?? 0n) + toUsdCents(w.amount, asset.decimals, price);
      }
    }
    for (const f of batch.fills ?? []) {
      if (seenFills.has(f.id)) continue;
      s.fills.push(f);
      seenFills.add(f.id);
    }

    // Pair new credits with waiting deposits, then new deposits with waiting credits.
    const open = <T extends { ev: { asset: AssetKey } }>(xs: T[], asset: AssetKey) => xs.filter((x) => x.ev.asset === asset);
    for (const c of newCredits) {
      const cs = s.credits.find((x) => x.ev.id === c.id)!;
      tryMatchCredit(ctx, cs, open(s.deposits, c.asset));
    }
    for (const d of newDeposits) {
      const ds = s.deposits.find((x) => x.ev.id === d.id)!;
      if (!ds.matchedCreditId) tryMatchDeposit(ctx, ds, open(s.credits, d.asset));
    }

    s.lastAsOfMs = batch.asOfMs;
    this.prune(batch.asOfMs);
  }

  private prune(now: number): void {
    const s = this.state;
    const g = this.cfg.ghost;
    s.credits = s.credits.filter((c) => (c.matchedDepositId ? now - (c.matchedAtMs ?? c.ev.atMs) < RETAIN_MATCHED_MS : now - c.ev.atMs < g.holdMs));
    const liveCredits = new Set(s.credits.map((c) => c.ev.id));
    s.deposits = s.deposits.filter((d) => (d.matchedCreditId ? liveCredits.has(d.matchedCreditId) : now - d.ev.atMs < g.depositLookbackMs));
    s.withdrawals = s.withdrawals.filter((w) => now - w.atMs < 24 * HOUR);
    s.fills = s.fills.filter((f) => now - f.atMs < this.cfg.concentration.windowMs);
    for (const series of Object.values(s.hotWallets)) {
      while (series.length > 1 && series[0]!.atMs < now - this.cfg.anomaly.drainWindowMs - this.cfg.stepMs) series.shift();
    }
    const horizon = now - (this.cfg.anomaly.baselineMaxHours + 2) * HOUR;
    for (const buckets of Object.values(s.outflowHourly)) for (const k of Object.keys(buckets)) if (Number(k) < horizon) delete buckets[k];
  }

  evaluate(asOfMs: number = this.state.lastAsOfMs): EngineReport {
    const ctx = makeCtx(this.cfg, this.state, asOfMs);
    const epoch = Math.floor(asOfMs / this.cfg.stepMs);

    const assetComps = new Map<AssetKey, ComponentResult[]>();
    const assetsOut: ComponentResult[] = [];
    for (const a of this.cfg.assets) {
      const comps: ComponentResult[] = [];
      // Backing, ghost credits and bridge outflows only exist for bridged assets; native NEAR
      // assets (wNEAR, native USDC) are issuer-backed and never leave through a bridge.
      if (isBridged(ctx, a.key)) comps.push(checkBacking(ctx, a.key), checkGhost(ctx, a.key), checkAnomaly(ctx, a.key));
      if (a.stable) comps.push(checkDepeg(ctx, a.key));
      assetComps.set(a.key, comps);
      assetsOut.push(...comps);
    }
    const chainComps = new Map(this.cfg.chains.map((c) => [c.id, checkChain(ctx, c.id)]));

    const routes: RouteVerdict[] = [];
    const contagionMap: Record<string, RouteId[]> = {};
    for (const routeId of this.cfg.routes) {
      const r = parseRoute(routeId);
      const comps: ComponentResult[] = [];
      const missing: string[] = [];
      for (const a of [r.src, r.dst]) {
        const ac = assetComps.get(a);
        if (ac) comps.push(...ac);
        else missing.push(a);
      }
      comps.push(checkConcentration(ctx, r.id));
      for (const ch of routeChains(r.id)) {
        const cc = chainComps.get(ch);
        if (cc) comps.push(cc);
        else missing.push(ch);
      }
      const scored = scoreRoute(ctx, comps);
      let raw: Status = scored.raw;
      const reasons = [...scored.reasons];
      if (missing.length > 0) {
        raw = raw === "red" ? "red" : "unknown";
        for (const m of missing) reasons.unshift(withSubject("NO_DATA", m));
      }
      const { status, held } = applyHysteresis(ctx, r.id, raw);
      if (held) reasons.push("HYSTERESIS_HOLD");
      const cap = routeCapacity(ctx, r.id, status);
      const verdict: Omit<RouteVerdict, "reportHash"> = {
        route: r.id,
        status,
        rawStatus: raw,
        score: capScore(scored.score, status),
        reasons: orderReasons([...new Set(reasons)], this.cfg.scorer.maxReasons),
        contagion: scored.contagion,
        capacityUsd: cap.capacityUsd,
        capacityBasis: cap.capacityBasis,
        components: comps,
      };
      const reportHash = verdictHash(verdict, { engine: ENGINE_VERSION, epoch, asOfMs, inputs: this.state.inputsDigest });
      routes.push({ ...verdict, reportHash });
      for (const ch of scored.contagion) (contagionMap[ch] ??= []).push(r.id);
    }

    return {
      engineVersion: ENGINE_VERSION,
      asOfMs,
      epoch,
      inputsDigest: this.state.inputsDigest,
      routes,
      assets: assetsOut,
      chains: [...chainComps.values()],
      contagionMap,
    };
  }
}

/** The hash watchers sign. Anyone holding the published report can recompute it. */
export function verdictHash(
  v: Omit<RouteVerdict, "reportHash">,
  meta: { engine: string; epoch: number; asOfMs: number; inputs: string },
): string {
  return hashCanonical({ v: 1, ...meta, verdict: v });
}

export function verifyVerdict(v: RouteVerdict, meta: { engine: string; epoch: number; asOfMs: number; inputs: string }): boolean {
  const { reportHash, ...rest } = v;
  return verdictHash(rest, meta) === reportHash;
}

export type { Ctx };
