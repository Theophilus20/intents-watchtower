import type { Attestation, ContractMirror, SubmitOutcome, VerdictPayload } from "@watchtower/core";
import { upgradeNearRpc } from "@watchtower/collectors";

/** Where signed verdicts go: the real contract, a local mirror, or an aggregator in front of either. */
export interface Submitter {
  submit(payload: VerdictPayload, attestations: Attestation[]): Promise<SubmitOutcome & { tx?: string }>;
  /**
   * Several routes in one transaction (the contract's submit_reports). Returns one outcome per
   * item, or null where the contract already held a newer verdict for that route.
   */
  submitMany?(items: { payload: VerdictPayload; attestations: Attestation[] }[]): Promise<(SubmitOutcome | null)[]>;
}

/** In-process contract model (local demos, tests, the status page). */
export class MirrorSubmitter implements Submitter {
  constructor(readonly mirror: ContractMirror) {}
  async submit(payload: VerdictPayload, attestations: Attestation[]) {
    return this.mirror.submitReport(payload, attestations);
  }
}

/**
 * Calls watchtower.near's submit_report through near-api-js. The paying account can be the
 * watcher itself or any relayer: authority comes from the signatures inside `attestations`.
 */
export class NearSubmitter implements Submitter {
  private account?: unknown;
  constructor(readonly opts: { rpcUrl: string; contractId: string; accountId: string; privateKey: string; gasTgas?: number }) {
    this.opts = { ...opts, rpcUrl: upgradeNearRpc(opts.rpcUrl) };
  }

  async submit(payload: VerdictPayload, attestations: Attestation[]) {
    const { Account } = await import("near-api-js");
    this.account ??= new Account(this.opts.accountId, this.opts.rpcUrl, this.opts.privateKey as `ed25519:${string}`);
    const { route_id, ...report } = payload;
    const out = await (this.account as InstanceType<typeof Account>).callFunction({
      contractId: this.opts.contractId,
      methodName: "submit_report",
      args: { route_id, report, attestations },
      gas: BigInt(this.opts.gasTgas ?? 100) * 10n ** 12n,
    });
    return out as unknown as SubmitOutcome;
  }

  /** One transaction per round instead of one per route: the base cost of a transaction is paid once. */
  async submitMany(items: { payload: VerdictPayload; attestations: Attestation[] }[]) {
    const { Account } = await import("near-api-js");
    this.account ??= new Account(this.opts.accountId, this.opts.rpcUrl, this.opts.privateKey as `ed25519:${string}`);
    const out: (SubmitOutcome | null)[] = [];
    for (let i = 0; i < items.length; i += BATCH) {
      const reports = items.slice(i, i + BATCH).map(({ payload: { route_id, ...report }, attestations }) => ({ route_id, report, attestations }));
      const res = await (this.account as InstanceType<typeof Account>).callFunction({
        contractId: this.opts.contractId,
        methodName: "submit_reports",
        args: { reports },
        gas: 300n * 10n ** 12n, // unused gas is refunded
      });
      out.push(...(res as unknown as (SubmitOutcome | null)[]));
    }
    return out;
  }
}

/** Reports per submit_reports call; the contract accepts up to 32, 16 keeps each call well under the gas limit. */
const BATCH = 16;

/**
 * Relayer mode: collect attestations from several watchers for the same (route, epoch, hash)
 * and submit them in one transaction once `batchSize` have arrived (or on flush).
 * Escalations (red) are forwarded immediately — the alarm never waits for co-signers.
 */
export class AggregatingSubmitter implements Submitter {
  private pending = new Map<string, { payload: VerdictPayload; atts: Attestation[] }>();
  constructor(readonly inner: Submitter, readonly batchSize: number) {}

  async submit(payload: VerdictPayload, attestations: Attestation[]) {
    const key = `${payload.route_id}|${payload.epoch}|${payload.report_hash}`;
    const entry = this.pending.get(key) ?? { payload, atts: [] };
    for (const a of attestations) if (!entry.atts.some((x) => x.watcher_id === a.watcher_id)) entry.atts.push(a);
    this.pending.set(key, entry);
    if (payload.status === "red" || entry.atts.length >= this.batchSize) {
      this.pending.delete(key);
      return this.inner.submit(entry.payload, entry.atts);
    }
    return { applied: false, votes: entry.atts.length, needed: this.batchSize, status: null };
  }

  async flush(): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const e of entries) await this.inner.submit(e.payload, e.atts).catch(() => undefined);
  }
}
