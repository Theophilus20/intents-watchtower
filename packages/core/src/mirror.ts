import { verifyAttestation, type Attestation, type VerdictPayload } from "./attest.ts";
import { isValidRouteId } from "./route.ts";
import { STATUS_RANK, type Status } from "./types.ts";

/**
 * A TypeScript model of watchtower.near's state machine (contracts/watchtower/src/lib.rs).
 *
 * Same rules, same messages, same signatures — used for local multi-watcher runs, the status
 * page, SDK tests and as an executable specification. Tests run identical cases against both.
 */
export interface MirrorRouteHealth {
  status: Status;
  score: number;
  capacity_usd: number;
  reasons: string[];
  epoch: number;
  report_hash: string;
  signers: number;
  updated_at_ms: number;
}

export interface MirrorRound {
  epoch: number;
  status: Status;
  score: number;
  capacity_usd: number;
  reasons: string[];
  report_hash: string;
  voters: string[];
}

export interface SafetyCheck {
  route_id: string;
  safe: boolean;
  verdict: "ok" | "paused" | "override" | "no_data" | "stale" | "status" | "over_capacity";
  status: Status | null;
  score: number | null;
  capacity_usd: number | null;
  reasons: string[];
  age_sec: number | null;
  report_hash: string | null;
}

export interface IntentCheck extends SafetyCheck {
  amount_usd: number;
  /** True only when the route is safe AND the amount fits the signed safe size. */
  allowed: boolean;
}

export interface SubmitOutcome {
  applied: boolean;
  votes: number;
  needed: number;
  status: Status | null;
}

export interface MirrorEvent {
  event: "route_health_updated" | "watcher_disagreement";
  data: Record<string, unknown>;
  atMs: number;
}

export class ContractMirror {
  readonly contractId: string;
  readonly watchers = new Map<string, string>(); // account -> ed25519 public key
  quorum: number;
  escalationThreshold: number;
  epochMs = 60_000;
  maxReportAgeSec = 900;
  defaultMaxAgeSec = 300;
  paused = false;
  readonly routes = new Map<string, MirrorRouteHealth>();
  readonly rounds = new Map<string, MirrorRound[]>();
  readonly overrides = new Map<string, Status>();
  readonly events: MirrorEvent[] = [];
  /** Block clock. Tests and the replay set it explicitly. */
  nowMs = Date.now();

  constructor(contractId: string, quorum: number, escalationThreshold = 1) {
    if (quorum < 1 || escalationThreshold < 1 || escalationThreshold > quorum) throw new Error("bad quorum");
    this.contractId = contractId;
    this.quorum = quorum;
    this.escalationThreshold = escalationThreshold;
  }

  addWatcher(account: string, publicKey: string): void {
    this.watchers.set(account, publicKey);
  }

  private ageSec(epoch: number): number {
    return Math.max(0, Math.floor((this.nowMs - epoch * this.epochMs) / 1000));
  }

  checkRoute(route: string, maxAgeSec?: number, allowAmber = false): SafetyCheck {
    const out: SafetyCheck = { route_id: route, safe: false, verdict: "ok", status: null, score: null, capacity_usd: null, reasons: [], age_sec: null, report_hash: null };
    if (this.paused) return { ...out, verdict: "paused" };
    const o = this.overrides.get(route);
    if (o) return { ...out, verdict: "override", status: o, safe: o === "green" || (o === "amber" && allowAmber) };
    const h = this.routes.get(route);
    if (!h) return { ...out, verdict: "no_data" };
    const age = this.ageSec(h.epoch);
    Object.assign(out, { status: h.status, score: h.score, capacity_usd: h.capacity_usd, reasons: h.reasons, age_sec: age, report_hash: h.report_hash });
    if (age > (maxAgeSec ?? this.defaultMaxAgeSec)) return { ...out, verdict: "stale" };
    out.safe = h.status === "green" || (h.status === "amber" && allowAmber);
    if (!out.safe) out.verdict = "status";
    return out;
  }

  isSafe(route: string, maxAgeSec?: number, allowAmber = false): boolean {
    return this.checkRoute(route, maxAgeSec, allowAmber).safe;
  }

  checkIntent(route: string, amountUsd: number, maxAgeSec?: number, allowAmber = false): IntentCheck {
    const c = this.checkRoute(route, maxAgeSec, allowAmber);
    const fits = c.capacity_usd !== null && amountUsd <= c.capacity_usd;
    return { ...c, amount_usd: amountUsd, allowed: c.safe && fits, verdict: c.safe && !fits ? "over_capacity" : c.verdict };
  }

  /**
   * The verdict from each watcher's latest fresh vote, exactly as the contract decides it:
   * red, then amber, as soon as `escalationThreshold` watchers say so; green when `quorum` agree
   * and no alarm stands (a watcher that can't see doesn't block the ones that can); unknown when
   * `escalationThreshold` can't see; otherwise no decision.
   */
  decide(fresh: MirrorRound[]): { status: Status; set: MirrorRound[] } | null {
    const pick = (f: (s: Status) => boolean) => fresh.filter((v) => f(v.status));
    const red = pick((s) => s === "red");
    if (red.length >= this.escalationThreshold) return { status: "red", set: red };
    const warn = pick((s) => s === "red" || s === "amber");
    if (warn.length >= this.escalationThreshold) return { status: "amber", set: warn };
    const greens = pick((s) => s === "green").sort((a, b) => b.epoch - a.epoch);
    if (greens.length >= this.quorum) return { status: "green", set: greens };
    const unknown = pick((s) => s === "unknown");
    if (unknown.length >= this.escalationThreshold) return { status: "unknown", set: unknown };
    return null;
  }

  submitReport(payload: VerdictPayload, attestations: Attestation[]): SubmitOutcome {
    const route = payload.route_id;
    if (!isValidRouteId(route)) throw new Error("invalid route asset");
    if (attestations.length === 0 || attestations.length > 32) throw new Error("1..=32 attestations required");
    const obsMs = payload.epoch * this.epochMs;
    if (obsMs > this.nowMs + 120_000) throw new Error("report epoch is in the future");
    if (this.nowMs - obsMs > this.maxReportAgeSec * 1000) throw new Error("report is too old");
    const current = this.routes.get(route);

    const signers: string[] = [];
    for (const a of attestations) {
      if (signers.includes(a.watcher_id)) throw new Error("duplicate watcher in attestations");
      const pk = this.watchers.get(a.watcher_id);
      if (!pk) throw new Error(`${a.watcher_id} is not a registered watcher`);
      if (!verifyAttestation(this.contractId, payload, a, pk)) throw new Error(`invalid signature from ${a.watcher_id}`);
      signers.push(a.watcher_id);
    }

    // Each signer's latest vote replaces its previous one (an older report from it is ignored).
    let votes = [...(this.rounds.get(route) ?? [])];
    let changedVote = false;
    for (const id of signers) {
      const i = votes.findIndex((v) => v.voters[0] === id);
      if (i >= 0) {
        if (votes[i]!.epoch > payload.epoch) continue;
        changedVote ||= votes[i]!.status !== payload.status;
        votes.splice(i, 1);
      } else changedVote = true;
      votes.push({ epoch: payload.epoch, status: payload.status, score: payload.score, capacity_usd: payload.capacity_usd, reasons: payload.reasons, report_hash: payload.report_hash, voters: [id] });
    }
    votes = votes.filter((v) => this.watchers.has(v.voters[0]!)).sort((a, b) => b.epoch - a.epoch).slice(0, 32);
    const fresh = votes.filter((v) => this.ageSec(v.epoch) <= this.defaultMaxAgeSec);
    if (changedVote && fresh.some((v) => v.status !== payload.status)) {
      this.events.push({ event: "watcher_disagreement", data: { route_id: route, epoch: payload.epoch, report_hashes: fresh.map((v) => v.report_hash) }, atMs: this.nowMs });
    }

    const agreeing = fresh.filter((v) => v.status === payload.status).length;
    const needed = payload.status === "green" ? this.quorum : this.escalationThreshold;
    let applied = false;
    const d = this.decide(fresh);
    if (d) {
      const same = d.set.filter((v) => v.status === d.status);
      const rep = same.reduce((a, b) => (b.epoch > a.epoch ? b : a), same[0] ?? d.set[0]!);
      const health: MirrorRouteHealth = {
        status: d.status,
        score: Math.min(...same.map((v) => v.score)),
        capacity_usd: STATUS_RANK[d.status] >= STATUS_RANK.unknown ? 0 : Math.min(...same.map((v) => v.capacity_usd)),
        reasons: rep.reasons,
        epoch: d.status === "green" ? d.set[this.quorum - 1]?.epoch ?? rep.epoch : rep.epoch,
        report_hash: rep.report_hash,
        signers: d.set.length,
        updated_at_ms: this.nowMs,
      };
      const unchanged = !!current && current.status === health.status && current.epoch === health.epoch && current.report_hash === health.report_hash && current.capacity_usd === health.capacity_usd && current.score === health.score && current.signers === health.signers;
      if (current?.status !== health.status) {
        this.events.push({ event: "route_health_updated", data: { route_id: route, from: current?.status ?? null, to: health.status, epoch: health.epoch, report_hash: health.report_hash, signers: health.signers, reasons: health.reasons }, atMs: this.nowMs });
      }
      if (!unchanged) {
        this.routes.set(route, health);
        applied = true;
      }
    }
    this.rounds.set(route, votes);
    return { applied, votes: agreeing, needed, status: this.routes.get(route)?.status ?? null };
  }

  /** JSON-RPC-shaped view dispatcher so the SDK can talk to a mirror exactly like to the chain. */
  view(method: string, args: Record<string, unknown>): unknown {
    const route = String(args.route_id ?? "");
    const maxAge = args.max_age_sec as number | undefined;
    const allowAmber = (args.allow_amber as boolean | undefined) ?? false;
    switch (method) {
      case "is_safe": return this.isSafe(route, maxAge, allowAmber);
      case "check_route": return this.checkRoute(route, maxAge, allowAmber);
      case "check_intent": return this.checkIntent(route, Number(args.amount_usd ?? 0), maxAge, allowAmber);
      case "check_routes": return (args.route_ids as string[]).map((r) => this.checkRoute(r, maxAge, allowAmber));
      case "safest_route": {
        let best: [string, number] | null = null;
        for (const r of args.candidates as string[]) {
          const c = this.checkRoute(r, maxAge, allowAmber);
          if (c.safe && (best === null || (c.score ?? 0) > best[1])) best = [r, c.score ?? 0];
        }
        return best?.[0] ?? null;
      }
      case "get_route_health": {
        const h = this.routes.get(route);
        return h ? { ...h, updated_at_ns: String(BigInt(h.updated_at_ms) * 1_000_000n) } : null;
      }
      case "list_routes": return [...this.routes.entries()].slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? 50));
      case "get_pending_rounds": return this.rounds.get(route) ?? [];
      case "get_watchers": return [...this.watchers.entries()].map(([account_id, public_key]) => ({ account_id, public_key }));
      default: throw new Error(`MethodNotFound: ${method}`);
    }
  }
}
