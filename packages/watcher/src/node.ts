import type { EngineReport, ObservationBatch, RouteVerdict, Status } from "@watchtower/core";
import { signAttestation, type Attestation, type VerdictPayload } from "@watchtower/core";
import { RiskEngine, defaultConfig, type EngineConfig } from "@watchtower/engine";
import type { Submitter } from "./submitter.ts";

export interface WatcherOptions {
  watcherId: string;
  secretKey: string;
  contractId: string;
  config?: EngineConfig;
  submitter?: Submitter;
  /**
   * Re-attest an unchanged status this often so the on-chain view stays fresh (default 4 epochs).
   * Unchanged "unknown" verdicts are never re-sent: a stale unknown reads exactly like a fresh one
   * (not safe), so refreshing it would only cost gas.
   */
  refreshEpochs?: number;
  /** Serialized engine state to resume from (baselines, open ghost credits, hysteresis). */
  state?: string;
}

export interface StepResult {
  report: EngineReport;
  attestations: { payload: VerdictPayload; attestation: Attestation; outcome?: Awaited<ReturnType<Submitter["submit"]>>; error?: string }[];
  transitions: { route: string; from: Status | null; to: Status; verdict: RouteVerdict }[];
}

/**
 * One watcher: ingest → evaluate → sign → submit. Signs only when something changed or the
 * last attestation is getting old, and sends the whole round in one transaction when the
 * submitter supports it, so a quiet day costs a few transactions an hour.
 */
/** True when the contract ran and refused the call, as opposed to the request never reaching it. */
export function isContractRejection(err: unknown): boolean {
  return /panicked|FunctionCallError|ExecutionError|ActionError|GuestPanic|MethodNotFound|CompilationError/i.test(String((err as Error)?.message ?? err));
}

export class WatcherNode {
  readonly engine: RiskEngine;
  private lastSigned = new Map<string, { status: Status; epoch: number; hash: string }>();
  private lastStatus = new Map<string, Status>();

  constructor(readonly opts: WatcherOptions) {
    const cfg = opts.config ?? defaultConfig();
    this.engine = opts.state ? RiskEngine.restore(cfg, opts.state) : new RiskEngine(cfg);
  }

  async step(batch: ObservationBatch): Promise<StepResult> {
    const report = this.engine.step(batch);
    const result: StepResult = { report, attestations: [], transitions: [] };
    const refresh = this.opts.refreshEpochs ?? 4;
    const changes = new Set<string>();
    for (const v of report.routes) {
      const prev = this.lastStatus.get(v.route);
      if (prev !== v.status) result.transitions.push({ route: v.route, from: prev ?? null, to: v.status, verdict: v });
      this.lastStatus.set(v.route, v.status);
      const last = this.lastSigned.get(v.route);
      const changed = !last || last.status !== v.status;
      const due = changed || (v.status !== "unknown" && report.epoch - last.epoch >= refresh);
      if (!due) continue;
      if (changed) changes.add(v.route);
      const payload: VerdictPayload = { route_id: v.route, epoch: report.epoch, status: v.status, score: v.score, capacity_usd: v.capacityUsd, reasons: v.reasons, report_hash: v.reportHash };
      const attestation = signAttestation(this.opts.contractId, payload, this.opts.watcherId, this.opts.secretKey);
      result.attestations.push({ payload, attestation });
    }

    const s = this.opts.submitter;
    const entries = result.attestations;
    if (s && entries.length) {
      let sent = false;
      if (s.submitMany && entries.length > 1) {
        try {
          const outs = await s.submitMany(entries.map((e) => ({ payload: e.payload, attestations: [e.attestation] })));
          entries.forEach((e, i) => { e.outcome = outs[i] ?? { applied: false, votes: 0, needed: 0, status: null }; });
          sent = true;
        } catch (err) {
          // A failed batch changes nothing on-chain. If the contract rejected it, send one by one
          // so a single bad report can't hold back the others, an alarm included. If the RPC
          // itself failed (rate limit, connection), one-by-one would only fail 12 more times.
          if (!isContractRejection(err)) {
            for (const e of entries) e.error = (err as Error).message;
            sent = true;
          }
        }
      }
      if (!sent) {
        for (const e of entries) {
          try {
            e.outcome = await s.submit(e.payload, [e.attestation]);
          } catch (err) {
            e.error = (err as Error).message;
          }
        }
      }
    }
    for (const e of entries) {
      // A change that failed to send is retried next epoch; a failed refresh waits for the next refresh.
      if (e.error && changes.has(e.payload.route_id)) continue;
      this.lastSigned.set(e.payload.route_id, { status: e.payload.status, epoch: report.epoch, hash: e.payload.report_hash });
    }
    return result;
  }
}
