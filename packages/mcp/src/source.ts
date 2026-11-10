import type { RouteVerdict, VerdictPayload } from "@watchtower/core";
import { ContractMirror, DEFAULT_ROUTES, generateWatcherKey, signAttestation } from "@watchtower/core";
import { SCENARIOS, ScenarioRun, type Frame } from "@watchtower/replay";
import { NETWORKS, Watchtower } from "@watchtower/sdk";

/**
 * Where the answers come from.
 *
 *   live    the watchtower contract on NEAR, through the public SDK (exactly what an integrator calls)
 *   replay  a recorded incident, re-run through the real engine, signed by demo watchers and loaded
 *           into the TypeScript model of the contract. Same SDK calls, clearly labelled as simulated.
 */
export interface Source {
  kind: "live" | "replay";
  /** One line for every answer, so nobody mistakes a replay for the live network. */
  label: string;
  client: Watchtower;
  routes(): Promise<string[]>;
  /** Full verdict with evidence, when the source has it (replay). */
  verdict(route: string): RouteVerdict | undefined;
}

export const DEMO_CONTRACT = "watchtower.near";

const DEMO_WATCHERS = [1, 2, 3].map((n) => {
  const seed = new Uint8Array(32);
  new TextEncoder().encodeInto(`watchtower-demo-w${n}`, seed);
  return { id: `w${n}.watchtower.near`, key: generateWatcherKey(seed) };
});

export interface ReplayOptions {
  scenario?: string;
  /** Minutes relative to the incident (negative = before). Default: 30 minutes after. */
  at?: number;
}

export function replaySource(opts: ReplayOptions = {}): Source {
  const scenario = SCENARIOS.find((s) => s.id === (opts.scenario ?? "oct-2026-ghost-credit"));
  if (!scenario) throw new Error(`Unknown scenario "${opts.scenario}". Available: ${SCENARIOS.map((s) => s.id).join(", ")}.`);
  const at = Math.max(-scenario.incidentAtMin, Math.min(opts.at ?? 30, scenario.durationMin - scenario.incidentAtMin));
  const run = new ScenarioRun(scenario, { keepVerdicts: true });
  let frame: Frame | null = null;
  for (let f = run.step(); f; f = run.step()) {
    frame = f;
    if (f.t >= at) break;
  }
  if (!frame) throw new Error("Scenario produced no frames");

  const mirror = new ContractMirror(DEMO_CONTRACT, 2, 1);
  mirror.nowMs = frame.asOfMs + 5_000;
  for (const w of DEMO_WATCHERS) mirror.addWatcher(w.id, w.key.publicKey);
  for (const r of frame.routes) {
    const p: VerdictPayload = { route_id: r.route, epoch: frame.epoch, status: r.status, score: r.score, capacity_usd: r.capacityUsd, reasons: r.reasons.slice(0, 16), report_hash: r.reportHash };
    mirror.submitReport(p, DEMO_WATCHERS.slice(0, 2).map((w) => signAttestation(DEMO_CONTRACT, p, w.id, w.key.secretKey)));
  }
  const verdicts = new Map((frame.verdicts ?? []).map((v) => [v.route, v]));
  const when = frame.t === 0 ? "at the moment of the incident" : frame.t > 0 ? `${frame.t} min after the incident` : `${-frame.t} min before the incident`;
  const client = new Watchtower({ contractId: DEMO_CONTRACT, cacheMs: 0, source: { view: async <T>(m: string, a: Record<string, unknown>) => mirror.view(m, a) as T } });
  return {
    kind: "replay",
    label: `Replay of "${scenario.title}" (simulated data), ${when}. Use --live mainnet for the real network.`,
    client,
    routes: async () => frame!.routes.map((r) => r.route),
    verdict: (route) => verdicts.get(route),
  };
}

export interface LiveOptions {
  network?: keyof typeof NETWORKS;
  contractId?: string;
  rpcUrl?: string;
}

export function liveSource(opts: LiveOptions = {}): Source {
  const network = opts.network ?? "mainnet";
  const client = new Watchtower({ network, contractId: opts.contractId, rpcUrl: opts.rpcUrl, cacheMs: 3_000 });
  return {
    kind: "live",
    label: `Live: ${client.contractId} on NEAR ${network}.`,
    client,
    routes: async () => {
      try {
        const rows = await client.listRoutes(0, 200);
        return rows.length ? rows.map(([id]) => id) : [...DEFAULT_ROUTES];
      } catch {
        return [...DEFAULT_ROUTES];
      }
    },
    verdict: () => undefined,
  };
}
