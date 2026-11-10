import type { AssetKey, EngineReport, RouteId, RouteVerdict, Status } from "@watchtower/core";
import { STATUS_RANK } from "@watchtower/core";
import { RiskEngine, defaultConfig, type EngineConfig } from "@watchtower/engine";
import type { Scenario } from "./scenarios.ts";
import { World } from "./world.ts";

export interface RouteFrame {
  route: RouteId;
  status: Status;
  rawStatus: Status;
  score: number;
  capacityUsd: number;
  reasons: string[];
  reportHash: string;
}

export interface AssetFrame {
  asset: AssetKey;
  backingPpm: number | null;
  outflowZ100: number | null;
  hotWalletDropPpm: number;
  ghostUsdCents: string;
  status: Status;
}

export interface Frame {
  minute: number;
  /** minutes relative to the incident (negative = before) */
  t: number;
  asOfMs: number;
  epoch: number;
  routes: RouteFrame[];
  assets: AssetFrame[];
  chains: { chain: string; status: Status; reasons: string[] }[];
  contagionMap: Record<string, RouteId[]>;
  markers: string[];
  /** Cumulative value the attacker had withdrawn by this minute (attack scenarios). */
  drainedUsdCents: string;
  /** Full verdicts (components, metrics, evidence) when RunOptions.keepVerdicts is set. */
  verdicts?: RouteVerdict[];
  inputsDigest: string;
}

export interface Transition {
  minute: number;
  t: number;
  route: RouteId;
  from: Status;
  to: Status;
  reasons: string[];
  /** Full verdict at the moment of the transition (components, metrics, evidence). */
  verdict: RouteVerdict;
}

export interface ReplayResult {
  scenario: Pick<Scenario, "id" | "title" | "summary" | "simulated" | "basis" | "incidentAtMin" | "durationMin" | "focusRoutes" | "focusAssets">;
  frames: Frame[];
  transitions: Transition[];
  summary: ReplaySummary;
  finalReport: EngineReport;
}

export interface ReplaySummary {
  /** First minute (relative to incident) any focus route left green. */
  firstAlertT: number | null;
  firstRedT: number | null;
  /** First minute is_safe(route, allow_amber=false) is false for every focus route. */
  allFocusUnsafeT: number | null;
  /** Worst status any focus route reached. */
  focusWorst: Status;
  /** Route-minutes red on routes that were *not* in focus (false positives / collateral). */
  collateralRedMinutes: number;
  collateralAlertMinutes: number;
  /** All focus routes back to their pre-incident status (or better) by the end. */
  recovered: boolean;
  attack?: {
    ghostCreditedUsdCents: string;
    withdrawnUsdCents: string;
    withdrawnAfterRedUsdCents: string;
    shareAfterRedPpm: number;
    firstGhostT: number | null;
  };
}

export interface RunOptions {
  config?: EngineConfig;
  /** Called after every frame (used by the browser to animate while computing). */
  onFrame?: (f: Frame) => void;
  /** Keep every route's full verdict in each frame (the status page's detail view needs it). */
  keepVerdicts?: boolean;
}

/**
 * The time machine. Drives a deterministic world minute by minute through the real engine,
 * records every frame, and measures what the engine did: when it alerted, how precisely, and
 * how much value moved after the alarm.
 */
export function runScenario(scenario: Scenario, opts: RunOptions = {}): ReplayResult {
  const run = new ScenarioRun(scenario, opts);
  while (run.step()) {
    /* drive to the end */
  }
  return run.finish();
}

/**
 * The same replay, one minute at a time, so a UI can render frames while later ones compute.
 *   const run = new ScenarioRun(s); while (run.step()) await nextFrame(); const result = run.finish();
 */
export class ScenarioRun {
  readonly frames: Frame[] = [];
  readonly transitions: Transition[] = [];
  private readonly cfg: EngineConfig;
  private readonly world: World;
  private readonly engine: RiskEngine;
  private readonly last = new Map<RouteId, Status>();
  private minute = 0;
  private report?: EngineReport;

  constructor(readonly scenario: Scenario, readonly opts: RunOptions = {}) {
    this.cfg = opts.config ?? defaultConfig();
    this.world = new World({ seed: scenario.seed, startMs: scenario.startMs - scenario.incidentAtMin * 60_000, assets: this.cfg.assets, chains: this.cfg.chains, routes: this.cfg.routes });
    this.engine = new RiskEngine(this.cfg);
  }

  get done(): boolean {
    return this.minute > this.scenario.durationMin;
  }

  /** Advance one minute. Returns the new frame, or null when the scenario is over. */
  step(): Frame | null {
    if (this.done) return null;
    const { scenario, world, engine, cfg } = this;
    const minute = this.minute++;
    const due = scenario.events.filter((e) => e.atMin === minute);
    const batch = world.tick(cfg.stepMs, (w) => {
      for (const e of due) e.apply(w);
    });
    const report = (this.report = engine.step(batch));
    const t = minute - scenario.incidentAtMin;
    for (const r of report.routes) {
      const prev = this.last.get(r.route);
      if (prev !== undefined && prev !== r.status) this.transitions.push({ minute, t, route: r.route, from: prev, to: r.status, reasons: r.reasons, verdict: r });
      this.last.set(r.route, r.status);
    }
    const drained = world.attackLog.filter((a) => a.kind === "withdrawal").reduce((s, a) => s + a.usdCents, 0n);
    const frame: Frame = {
      minute,
      t,
      asOfMs: report.asOfMs,
      epoch: report.epoch,
      routes: report.routes.map(toRouteFrame),
      assets: assetFrames(report),
      chains: report.chains.map((c) => ({ chain: c.subject, status: c.status, reasons: c.reasons })),
      contagionMap: report.contagionMap,
      markers: due.map((e) => e.label),
      drainedUsdCents: drained.toString(),
      verdicts: this.opts.keepVerdicts ? report.routes : undefined,
      inputsDigest: report.inputsDigest,
    };
    this.frames.push(frame);
    this.opts.onFrame?.(frame);
    return frame;
  }

  finish(): ReplayResult {
    while (this.step()) {
      /* complete any remaining minutes */
    }
    const { scenario, frames, world } = this;
    const focus = new Set(scenario.focusRoutes);
    const tOf = (minute: number) => minute - scenario.incidentAtMin;
    let firstAlert: number | null = null, firstRed: number | null = null, allUnsafe: number | null = null;
    let focusWorst: Status = "green", collateralRed = 0, collateralAlert = 0;
    for (const f of frames) {
      if (f.t < 0) continue;
      const fr = f.routes.filter((r) => focus.has(r.route));
      for (const r of fr) if (STATUS_RANK[r.status] > STATUS_RANK[focusWorst]) focusWorst = r.status;
      if (firstAlert === null && fr.some((r) => r.status !== "green")) firstAlert = f.t;
      if (firstRed === null && fr.some((r) => r.status === "red")) firstRed = f.t;
      if (allUnsafe === null && fr.length > 0 && fr.every((r) => r.status !== "green")) allUnsafe = f.t;
      for (const r of f.routes) {
        if (focus.has(r.route)) continue;
        if (r.status === "red") collateralRed++;
        if (r.status !== "green") collateralAlert++;
      }
    }
    // Recovered = every focus route is back to (or better than) where it stood just before the incident.
    const lastFrame = frames[frames.length - 1]!;
    const before = frames.filter((f) => f.t < 0).at(-1) ?? frames[0]!;
    const baseline = new Map(before.routes.map((r) => [r.route, r.status]));
    const recovered = lastFrame.routes.filter((r) => focus.has(r.route)).every((r) => STATUS_RANK[r.status] <= STATUS_RANK[baseline.get(r.route) ?? "green"]);

    const summary: ReplaySummary = { firstAlertT: firstAlert, firstRedT: firstRed, allFocusUnsafeT: allUnsafe, focusWorst, collateralRedMinutes: collateralRed, collateralAlertMinutes: collateralAlert, recovered };
    const ghosts = world.attackLog.filter((a) => a.kind === "ghost_credit");
    if (ghosts.length > 0) {
      const wds = world.attackLog.filter((a) => a.kind === "withdrawal");
      const total = wds.reduce((s, a) => s + a.usdCents, 0n);
      // A withdrawal stamped inside the step that turned red happened *before* the alarm, so only
      // count withdrawals strictly after the red frame's timestamp.
      const redFrame = firstRed === null ? undefined : frames.find((f) => f.t === firstRed);
      const after = redFrame ? wds.filter((a) => a.atMs > redFrame.asOfMs).reduce((s, a) => s + a.usdCents, 0n) : 0n;
      const firstGhostMinute = frames.find((f) => f.asOfMs >= ghosts[0]!.atMs)?.minute;
      summary.attack = {
        ghostCreditedUsdCents: ghosts.reduce((s, a) => s + a.usdCents, 0n).toString(),
        withdrawnUsdCents: total.toString(),
        withdrawnAfterRedUsdCents: after.toString(),
        shareAfterRedPpm: total > 0n ? Number((after * 1_000_000n) / total) : 0,
        firstGhostT: firstGhostMinute === undefined ? null : tOf(firstGhostMinute),
      };
    }

    const { id, title, summary: s, simulated, basis, incidentAtMin, durationMin, focusRoutes, focusAssets } = scenario;
    return { scenario: { id, title, summary: s, simulated, basis, incidentAtMin, durationMin, focusRoutes, focusAssets }, frames, transitions: this.transitions, summary, finalReport: this.report! };
  }
}

function toRouteFrame(r: RouteVerdict): RouteFrame {
  return { route: r.route, status: r.status, rawStatus: r.rawStatus, score: r.score, capacityUsd: r.capacityUsd, reasons: r.reasons, reportHash: r.reportHash };
}

function assetFrames(report: EngineReport): AssetFrame[] {
  const by = new Map<string, AssetFrame>();
  for (const c of report.assets) {
    const a = by.get(c.subject) ?? { asset: c.subject, backingPpm: null, outflowZ100: null, hotWalletDropPpm: 0, ghostUsdCents: "0", status: "green" as Status };
    if (c.check === "backing" && typeof c.metrics.backing_ppm === "number" && c.metrics.backing_ppm >= 0) a.backingPpm = c.metrics.backing_ppm;
    if (c.check === "anomaly") {
      if (typeof c.metrics.outflow_z100 === "number") a.outflowZ100 = c.metrics.outflow_z100;
      a.hotWalletDropPpm = Number(c.metrics.hot_wallet_drop_ppm ?? 0);
    }
    if (c.check === "ghost") a.ghostUsdCents = String(BigInt(String(c.metrics.ghost_usd_cents ?? "0")) + BigInt(String(c.metrics.exited_usd_cents ?? "0")));
    if (STATUS_RANK[c.status] > STATUS_RANK[a.status]) a.status = c.status;
    by.set(c.subject, a);
  }
  return [...by.values()];
}
