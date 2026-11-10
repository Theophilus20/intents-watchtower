import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EngineReport, ObservationBatch, Status } from "@watchtower/core";
import { toJson } from "@watchtower/core";

/** Anything with node-postgres' query shape: `pg.Pool`, `pg.Client`, PGlite. */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec?(sql: string): Promise<unknown>;
}

export const MIGRATIONS = [fileURLToPath(new URL("../../../db/migrations/001_init.sql", import.meta.url))];

export interface AlertRow {
  route: string;
  severity: Status;
  fromStatus?: Status | null;
  reasons: string[];
  explanation: string;
  lang?: string;
  evidenceLinks?: string[];
  reportHash?: string;
  sentAtMs: number;
}

/**
 * Persistence for history, alerts and watcher state. The engine itself is pure; storage is
 * for the status page, the alert bot, audits and restarts.
 */
export class PgStore {
  constructor(readonly db: Queryable) {}

  async migrate(): Promise<void> {
    for (const file of MIGRATIONS) {
      const sql = readFileSync(file, "utf8");
      if (this.db.exec) await this.db.exec(sql);
      else for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await this.db.query(stmt);
    }
  }

  async saveBatch(b: ObservationBatch): Promise<void> {
    for (const c of b.credits ?? []) await this.db.query("INSERT INTO credits (id, asset, amount, account, near_tx, source_tx_ref, at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING", [c.id, c.asset, c.amount.toString(), c.account, c.nearTx, c.sourceTxRef ?? null, c.atMs]);
    for (const d of b.deposits ?? []) await this.db.query("INSERT INTO deposits (id, asset, amount, account, source_tx, at_ms) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING", [d.id, d.asset, d.amount.toString(), d.account ?? null, d.sourceTx, d.atMs]);
    for (const w of b.withdrawals ?? []) await this.db.query("INSERT INTO withdrawals (id, asset, amount, account, near_tx, dest_chain, dest_tx, at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING", [w.id, w.asset, w.amount.toString(), w.account, w.nearTx, w.destChain, w.destTx ?? null, w.atMs]);
    for (const s of b.custody ?? []) await this.db.query("INSERT INTO custody_snapshots (asset, balance, at_ms) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [s.asset, s.balance.toString(), s.atMs]);
    for (const s of b.supply ?? []) await this.db.query("INSERT INTO supply_snapshots (asset, credited, pending_withdrawals, at_ms) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [s.asset, s.credited.toString(), s.pendingWithdrawals.toString(), s.atMs]);
    for (const f of b.fills ?? []) await this.db.query("INSERT INTO solver_fills (id, route, solver, usd_cents, at_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING", [f.id, f.route, f.solver, f.usdCents.toString(), f.atMs]);
    for (const c of b.chains ?? []) await this.db.query("INSERT INTO chain_status (chain, head_height, head_time_ms, finality_lag_blocks, reorg_depth, at_ms) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", [c.chain, c.headHeight, c.headTimeMs, c.finalityLagBlocks ?? null, c.reorgDepth ?? null, c.atMs]);
  }

  async saveReport(r: EngineReport): Promise<void> {
    for (const v of r.routes) {
      await this.db.query(
        `INSERT INTO route_health (route, epoch, status, raw_status, score, reasons, report_hash, report, computed_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (route, epoch) DO UPDATE SET status = EXCLUDED.status, raw_status = EXCLUDED.raw_status, score = EXCLUDED.score,
           reasons = EXCLUDED.reasons, report_hash = EXCLUDED.report_hash, report = EXCLUDED.report, computed_at_ms = EXCLUDED.computed_at_ms`,
        [v.route, r.epoch, v.status, v.rawStatus, v.score, v.reasons, v.reportHash, toJson({ ...v, engine: r.engineVersion, inputs: r.inputsDigest, asOfMs: r.asOfMs }), r.asOfMs],
      );
    }
  }

  async saveAttestation(a: { route: string; epoch: number; reportHash: string; watcherId: string; signature: string; tx?: string; atMs: number }): Promise<void> {
    await this.db.query("INSERT INTO attestations (route, epoch, report_hash, watcher_id, signature, submitted_tx, at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [a.route, a.epoch, a.reportHash, a.watcherId, a.signature, a.tx ?? null, a.atMs]);
  }

  async saveAlert(a: AlertRow): Promise<number> {
    const r = await this.db.query<{ id: number }>(
      "INSERT INTO alerts (route, severity, from_status, reasons, explanation, lang, evidence_links, report_hash, sent_at_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [a.route, a.severity, a.fromStatus ?? null, a.reasons, a.explanation, a.lang ?? "en", a.evidenceLinks ?? [], a.reportHash ?? null, a.sentAtMs],
    );
    return Number(r.rows[0]!.id);
  }

  async recentAlerts(limit = 20): Promise<(AlertRow & { id: number })[]> {
    const r = await this.db.query<Record<string, unknown>>("SELECT * FROM alerts ORDER BY sent_at_ms DESC, id DESC LIMIT $1", [limit]);
    return r.rows.map((x) => ({ id: Number(x.id), route: String(x.route), severity: x.severity as Status, fromStatus: (x.from_status as Status) ?? null, reasons: x.reasons as string[], explanation: String(x.explanation), lang: String(x.lang), evidenceLinks: x.evidence_links as string[], reportHash: (x.report_hash as string) ?? undefined, sentAtMs: Number(x.sent_at_ms) }));
  }

  async routeHistory(route: string, sinceMs: number): Promise<{ epoch: number; status: Status; score: number; reasons: string[]; reportHash: string }[]> {
    const r = await this.db.query<Record<string, unknown>>("SELECT epoch, status, score, reasons, report_hash FROM route_health WHERE route = $1 AND computed_at_ms >= $2 ORDER BY epoch", [route, sinceMs]);
    return r.rows.map((x) => ({ epoch: Number(x.epoch), status: x.status as Status, score: Number(x.score), reasons: x.reasons as string[], reportHash: String(x.report_hash) }));
  }

  /** Verify a stored report still hashes to what was signed (tamper check for auditors). */
  async storedReport(route: string, epoch: number): Promise<Record<string, unknown> | null> {
    const r = await this.db.query<{ report: Record<string, unknown> | string }>("SELECT report FROM route_health WHERE route = $1 AND epoch = $2", [route, epoch]);
    const row = r.rows[0];
    if (!row) return null;
    return typeof row.report === "string" ? (JSON.parse(row.report) as Record<string, unknown>) : row.report;
  }

  async saveState(watcherId: string, state: string, asOfMs: number, inputsDigest: string): Promise<void> {
    await this.db.query(
      "INSERT INTO engine_state (watcher_id, state, as_of_ms, inputs_digest) VALUES ($1,$2,$3,$4) ON CONFLICT (watcher_id) DO UPDATE SET state = EXCLUDED.state, as_of_ms = EXCLUDED.as_of_ms, inputs_digest = EXCLUDED.inputs_digest",
      [watcherId, state, asOfMs, inputsDigest],
    );
  }

  async loadState(watcherId: string): Promise<string | null> {
    const r = await this.db.query<{ state: string }>("SELECT state FROM engine_state WHERE watcher_id = $1", [watcherId]);
    return r.rows[0]?.state ?? null;
  }
}

/** Zero-setup Postgres for development and tests: Postgres compiled to WASM, in-process. */
export async function openPglite(dataDir?: string): Promise<PgStore> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dataDir);
  const store = new PgStore(db as unknown as Queryable);
  await store.migrate();
  return store;
}
