import type { ComponentResult, RouteVerdict, Status } from "@watchtower/core";
import { ContractMirror, STATUS_RANK, describeReason, generateWatcherKey, parseRoute, reasonCode, reasonSubject, signAttestation, type Attestation, type VerdictPayload } from "@watchtower/core";
import type { Frame } from "@watchtower/replay";
import { RpcSource, Watchtower, type RouteHealth } from "@watchtower/sdk";
import { k, span, t } from "./i18n.ts";

/** What every view renders from, whether the data comes from a replay or the live contract. */
export interface RouteRow {
  route: string;
  status: Status;
  score: number;
  reasons: string[];
  reportHash: string;
  /** Full verdict with every check (replay, or live when the watcher publishes reports). */
  verdict?: RouteVerdict;
  backingPpm: number | null;
  /** Live: why the page couldn't read this route's backing (shown when hovering "n/a"). */
  backingError?: string;
  /** Safe size in whole USD; 0 = blocked. */
  capacityUsd: number;
  signers?: number;
  ageSec?: number;
}

export interface ChainRow {
  chain: string;
  status: Status;
  reasons: string[];
  secondsSinceBlock: number | null;
}

export interface AssetRow {
  asset: string;
  status: Status;
  /** Most severe reason for this asset, if any. */
  reason: string | null;
}

export interface Snapshot {
  kind: "replay" | "live";
  assets: AssetRow[];
  asOfMs: number;
  epoch: number;
  routes: RouteRow[];
  chains: ChainRow[];
  /** Unbacked value (credits with nothing behind them), USD cents. */
  unbackedCents: bigint;
  lowestBacking: { asset: string; ppm: number } | null;
  watchers: { agreeing: number; total: number };
  /** Live mode: bridged assets the page checked itself, and which hold less than they owe. */
  backed?: { full: number; total: number; short: string[] };
  /** Live mode: how the page's own backing check went. */
  backingNote?: { kind: "missing" | "checking" | "done"; atMs?: number; read?: number; total?: number; failed?: string[]; error?: string };
}

export const CHAIN_NAMES: Record<string, string> = { bitcoin: "Bitcoin", ethereum: "Ethereum", bsc: "BNB Chain", solana: "Solana", litecoin: "Litecoin", near: "NEAR" };
export const chainName = (id: string) => CHAIN_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

export function assetName(key: string): string {
  const [sym, chain] = key.split(":");
  return t("{sym} on {chain}", { sym: sym!.toUpperCase(), chain: chainName(chain!) });
}

export function routeLabel(route: string): { src: string; dst: string; srcChain: string; dstChain: string } {
  const r = parseRoute(route);
  return { src: r.srcSymbol.toUpperCase(), dst: r.dstSymbol.toUpperCase(), srcChain: chainName(r.srcChain), dstChain: chainName(r.dstChain) };
}

export function worst(statuses: Status[]): Status {
  return statuses.reduce<Status>((w, s) => (STATUS_RANK[s] > STATUS_RANK[w] ? s : w), "green");
}

// ---------------------------------------------------------------------------------------------
// Replay → snapshot
// ---------------------------------------------------------------------------------------------

export function snapshotFromFrame(f: Frame, watchersAgreeing = 3): Snapshot {
  const backingByAsset = new Map(f.assets.map((a) => [a.asset, a.backingPpm]));
  const routes: RouteRow[] = f.routes.map((r) => {
    const verdict = f.verdicts?.find((v) => v.route === r.route);
    const p = parseRoute(r.route);
    const b = [backingByAsset.get(p.src), backingByAsset.get(p.dst)].filter((x): x is number => typeof x === "number");
    return { route: r.route, status: r.status, score: r.score, reasons: r.reasons, reportHash: r.reportHash, verdict, backingPpm: b.length ? Math.min(...b) : null, capacityUsd: r.capacityUsd, signers: 3, ageSec: 0 };
  });
  const chainSecs = new Map<string, number>();
  for (const v of f.verdicts ?? []) for (const c of v.components) if (c.check === "chain" && typeof c.metrics.seconds_since_block === "number") chainSecs.set(c.subject, c.metrics.seconds_since_block);
  const chains: ChainRow[] = f.chains.map((c) => ({ chain: c.chain, status: c.status, reasons: c.reasons, secondsSinceBlock: chainSecs.get(c.chain) ?? null }));
  let lowest: Snapshot["lowestBacking"] = null;
  for (const a of f.assets) if (a.backingPpm !== null && (!lowest || a.backingPpm < lowest.ppm)) lowest = { asset: a.asset, ppm: a.backingPpm };
  const unbacked = f.assets.reduce((s, a) => s + BigInt(a.ghostUsdCents), 0n);
  const assetReason = new Map<string, { rank: number; reason: string }>();
  for (const v of f.verdicts ?? []) for (const c of v.components) {
    if (c.status === "green" || !c.subject.includes(":") || c.subject.includes("->")) continue;
    const reason = c.reasons.find((r) => describeReason(r).severity !== "info");
    const rank = STATUS_RANK[c.status];
    if (reason && (assetReason.get(c.subject)?.rank ?? -1) < rank) assetReason.set(c.subject, { rank, reason });
  }
  const assets: AssetRow[] = f.assets.map((a) => ({ asset: a.asset, status: a.status, reason: assetReason.get(a.asset)?.reason ?? null }));
  return { kind: "replay", assets, asOfMs: f.asOfMs, epoch: f.epoch, routes, chains, unbackedCents: unbacked, lowestBacking: lowest, watchers: { agreeing: watchersAgreeing, total: 3 } };
}

// ---------------------------------------------------------------------------------------------
// Live contract → snapshot
// ---------------------------------------------------------------------------------------------

export const LIVE_NETWORKS = {
  testnet: { rpcUrl: "https://test.rpc.fastnear.com", contractId: "watchtower.testnet" },
  mainnet: { rpcUrl: "https://free.rpc.fastnear.com", contractId: "watchtower.near" },
} as const;

export async function fetchLive(network: keyof typeof LIVE_NETWORKS, contractId: string): Promise<Snapshot> {
  const src = new RpcSource(LIVE_NETWORKS[network].rpcUrl, contractId, undefined, 6000);
  const wt = new Watchtower({ source: src, cacheMs: 0 });
  const [rows, watchers] = await Promise.all([wt.listRoutes(0, 200), src.view<{ account_id: string }[]>("get_watchers", {})]);
  const checks = await wt.checkMany(rows.map(([r]) => r));
  const now = Date.now();
  const routes: RouteRow[] = rows.map(([route, h]: [string, RouteHealth], i) => ({
    route,
    status: checks[i]?.verdict === "stale" ? "unknown" : h.status,
    score: h.score,
    reasons: checks[i]?.verdict === "stale" ? ["STALE_ON_CHAIN", ...h.reasons] : h.reasons,
    reportHash: h.report_hash,
    backingPpm: null,
    capacityUsd: h.capacity_usd ?? 0,
    signers: h.signers,
    ageSec: checks[i]?.age_sec ?? undefined,
  }));
  // Chains are inferred from chain reasons on the routes that depend on them.
  const chainStatus = new Map<string, Status>();
  for (const r of routes) {
    for (const ch of [parseRoute(r.route).srcChain, parseRoute(r.route).dstChain, "near"]) if (!chainStatus.has(ch)) chainStatus.set(ch, "green");
    for (const reason of r.reasons) {
      const code = reasonCode(reason);
      const subj = reasonSubject(reason);
      if (code && subj && code.startsWith("CHAIN_")) chainStatus.set(subj, worst([chainStatus.get(subj) ?? "green", describeReason(reason).severity === "info" ? "green" : (describeReason(reason).severity as Status)]));
    }
  }
  // Assets likewise: a token's worst reason on any route (e.g. BACKING_PARTIAL:btc:bitcoin), so
  // the chain map shows a chain whose token can't be verified as such, not as "swaps can flow".
  const assetState = new Map<string, { status: Status; reason: string | null }>();
  for (const r of routes) {
    for (const reason of r.reasons) {
      const subj = reasonSubject(reason);
      if (!subj || !subj.includes(":")) continue;
      const sev = describeReason(reason).severity;
      const st: Status = sev === "info" ? "green" : (sev as Status);
      const cur = assetState.get(subj);
      if (!cur || STATUS_RANK[st] > STATUS_RANK[cur.status]) assetState.set(subj, { status: st, reason: st === "green" ? cur?.reason ?? null : reason });
    }
  }
  const latestEpoch = Math.max(0, ...rows.map(([, h]) => h.epoch));
  return {
    kind: "live",
    assets: [...assetState.entries()].map(([asset, x]) => ({ asset, status: x.status, reason: x.reason })),
    asOfMs: latestEpoch ? latestEpoch * 60_000 : now,
    epoch: latestEpoch,
    routes,
    chains: [...chainStatus.entries()].map(([chain, status]) => ({ chain, status, reasons: [], secondsSinceBlock: null })),
    unbackedCents: 0n,
    lowestBacking: null,
    watchers: { agreeing: Math.max(0, ...routes.map((r) => r.signers ?? 0)), total: watchers.length },
  };
}

// ---------------------------------------------------------------------------------------------
// Watchers and the contract model
// ---------------------------------------------------------------------------------------------

export const CONTRACT = "watchtower.near";
export const WATCHERS = [1, 2, 3].map((n) => {
  const seed = new Uint8Array(32);
  new TextEncoder().encodeInto(`watchtower-demo-w${n}`, seed);
  return { id: `w${n}.watchtower.near`, n, name: `Watcher ${n}`, key: generateWatcherKey(seed) };
});

export interface QuorumDemo {
  payload: VerdictPayload;
  attestations: { watcher: (typeof WATCHERS)[number]; att: Attestation; lying: boolean; verified: boolean }[];
  stored: Status | null;
  honest: { applied: boolean; votes: number; needed: number };
  liar: { applied: boolean; votes: number; needed: number } | null;
  disagreement: boolean;
}

/** Sign one route's verdict with all three watchers and run it through the contract model. */
export function quorumDemo(row: RouteRow, epoch: number, asOfMs: number, lying: boolean): QuorumDemo {
  const payload: VerdictPayload = { route_id: row.route, epoch, status: row.status, score: row.score, capacity_usd: row.capacityUsd, reasons: row.reasons.slice(0, 16), report_hash: row.reportHash };
  const forged: VerdictPayload = { ...payload, status: "green", score: 100, capacity_usd: 1_000_000, reasons: [], report_hash: [...row.reportHash].reverse().join("") };
  const mirror = new ContractMirror(CONTRACT, 2, 1);
  mirror.nowMs = asOfMs + 5_000;
  for (const w of WATCHERS) mirror.addWatcher(w.id, w.key.publicKey);
  const atts = WATCHERS.map((w, i) => {
    const isLiar = lying && i === 2;
    const att = signAttestation(CONTRACT, isLiar ? forged : payload, w.id, w.key.secretKey);
    return { watcher: w, att, lying: isLiar, verified: true };
  });
  const honest = mirror.submitReport(payload, [atts[0]!.att, atts[1]!.att]);
  const liar = lying ? mirror.submitReport(forged, [atts[2]!.att]) : null;
  if (!lying) mirror.submitReport(payload, [atts[2]!.att]);
  return {
    payload,
    attestations: atts,
    stored: mirror.checkRoute(row.route).status,
    honest: { applied: honest.applied, votes: honest.votes, needed: honest.needed },
    liar: liar ? { applied: liar.applied, votes: liar.votes, needed: liar.needed } : null,
    disagreement: mirror.events.some((e) => e.event === "watcher_disagreement"),
  };
}

/** A contract model holding every route of a snapshot, signed by two watchers (for the SDK demo). */
export function mirrorFor(s: Snapshot): ContractMirror {
  const mirror = new ContractMirror(CONTRACT, 2, 1);
  mirror.nowMs = s.asOfMs + 5_000;
  for (const w of WATCHERS) mirror.addWatcher(w.id, w.key.publicKey);
  for (const r of s.routes) {
    const p: VerdictPayload = { route_id: r.route, epoch: s.epoch, status: r.status, score: r.score, capacity_usd: r.capacityUsd, reasons: r.reasons.slice(0, 16), report_hash: r.reportHash };
    mirror.submitReport(p, WATCHERS.slice(0, 2).map((w) => signAttestation(CONTRACT, p, w.id, w.key.secretKey)));
  }
  return mirror;
}

// ---------------------------------------------------------------------------------------------
// Plain-language summaries of checks
// ---------------------------------------------------------------------------------------------

export const CHECK_TITLES: Record<ComponentResult["check"], string> = {
  backing: k("Backing"),
  ghost: k("Deposits behind credits"),
  anomaly: k("Withdrawal patterns"),
  concentration: k("Solver competition"),
  chain: k("Chain health"),
  depeg: k("Stablecoin peg"),
};

const usd = (v: unknown) => {
  const c = BigInt(String(v ?? "0"));
  const d = Number(c) / 100;
  if (d >= 1e6) return `$${(d / 1e6).toFixed(d >= 1e7 ? 1 : 2)}M`;
  if (d >= 1e4) return `$${(d / 1e3).toFixed(d >= 1e5 ? 0 : 1)}K`;
  return `$${d.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};

export function checkSummary(c: ComponentResult): string {
  const m = c.metrics;
  switch (c.check) {
    case "backing": {
      if (m.backing_ppm === undefined) return c.reasons.some((r) => r.startsWith("CUSTODY")) ? t("Custody balance not readable") : t("Credited supply not readable");
      if (Number(m.backing_ppm) < 0) return t("Nothing credited yet");
      const parts = [t("{pct}% backed", { pct: (Number(m.backing_ppm) / 10_000).toFixed(2) })];
      if (BigInt(String(m.deficit ?? "0")) > 0n) parts.push(t("{amount} short", { amount: usd(m.deficit_usd_cents) }));
      if (c.reasons.some((r) => r.startsWith("BACKING_DROP_FAST"))) parts.push(t("down {points} points in 15 min", { points: (Number(m.drop_ppm) / 10_000).toFixed(2) }));
      return parts.join(t(", "));
    }
    case "ghost": {
      if (Number(m.exiting_count)) return t("{amount} withdrawn against credits with no deposit", { amount: usd(m.exited_usd_cents) });
      if (Number(m.ghost_count)) return Number(m.ghost_count) === 1 ? t("1 credit never matched a deposit") : t("{n} credits never matched a deposit", { n: Number(m.ghost_count) });
      if (Number(m.pending_count)) return t("{amount} still waiting for its deposit", { amount: usd(m.pending_usd_cents) });
      return t("Every credit matches a deposit");
    }
    case "anomaly": {
      const parts: string[] = [];
      for (const r of c.reasons) {
        const code = reasonCode(r);
        if (code === "OUTFLOW_SPIKE") parts.push(typeof m.outflow_z100 === "number" ? t("withdrawals {z}σ above normal", { z: (m.outflow_z100 / 100).toFixed(1) }) : t("withdrawals far above normal"));
        if (code === "HOT_WALLET_DRAIN") parts.push(t("hot wallet down {pct}%", { pct: Math.round(Number(m.hot_wallet_drop_ppm) / 10_000) }));
        if (code === "FRESH_ACCOUNT_EXIT") parts.push(t("new accounts withdrew {amount}", { amount: usd(m.fresh_exit_usd_cents) }));
        if (code === "MINT_THEN_EXIT") parts.push(t("credited and pulled out within minutes"));
      }
      if (parts.length) return parts.join(t(", ")).replace(/^./, (x) => x.toUpperCase());
      return c.reasons.some((r) => r.startsWith("BASELINE")) ? t("Learning normal levels") : t("Normal");
    }
    case "concentration":
      if (m.hhi === undefined) return t("Too little activity to judge ({n} fills in 24h)", { n: Number(m.fills_24h ?? 0) });
      return t("{n} solvers, largest fills {pct}% (HHI {hhi})", { n: Number(m.solvers_24h), pct: Math.round(Number(m.top_solver_ppm) / 10_000), hhi: Number(m.hhi).toLocaleString("en-US") });
    case "chain": {
      if (c.reasons.some((r) => r.startsWith("CHAIN_ADVISORY"))) { const a = c.evidence.find((e) => e.kind === "advisory")?.label; return a ? t(a) : t("Security advisory active"); }
      if (m.seconds_since_block === undefined) return t("No recent data");
      const s = Number(m.seconds_since_block);
      const age = s < 90 ? t("{s} s", { s }) : span(Math.round(s / 60));
      return Number(m.reorg_depth) ? t("Reorganised {n} blocks, last block {age} ago", { n: Number(m.reorg_depth), age }) : t("Last block {age} ago", { age });
    }
    case "depeg":
      return m.price_micro_usd ? t("Trading at {price}", { price: `$${(Number(m.price_micro_usd) / 1e6).toFixed(4)}` }) : t("No recent price");
  }
}

export function fmtBacking(ppm: number | null): string {
  return ppm === null ? t("n/a") : `${(ppm / 10_000).toFixed(2)}%`;
}

export function fmtUsd(cents: bigint): string {
  return usd(cents);
}

// ---------------------------------------------------------------------------------------------
// Chain nodes for the map: a chain is only as healthy as the chain itself AND the tokens on it.
// ---------------------------------------------------------------------------------------------

export interface ChainNode {
  chain: string;
  status: Status;
  /** Plain-language "what's happening" line. */
  what: string;
  routes: RouteRow[];
  secondsSinceBlock: number | null;
}

export function chainNodes(s: Snapshot): ChainNode[] {
  return s.chains.map((c) => {
    const assets = s.assets.filter((a) => a.asset.endsWith(`:${c.chain}`));
    const routes = s.routes.filter((r) => { const p = parseRoute(r.route); return c.chain === "near" || p.srcChain === c.chain || p.dstChain === c.chain; });
    const status = worst([c.status, ...assets.map((a) => a.status)]);
    let what = t("Healthy");
    const chainReason = c.reasons.find((r) => describeReason(r).severity !== "info");
    const bad = [...assets].sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]).find((a) => a.status !== "green" && a.reason);
    if (chainReason && STATUS_RANK[c.status] >= STATUS_RANK[bad?.status ?? "green"]) what = t(describeReason(chainReason).title);
    else if (bad?.reason) what = t("{sym}: {problem}", { sym: bad.asset.split(":")[0]!.toUpperCase(), problem: t(describeReason(bad.reason).title) });
    else if (status !== "green") what = t("Some routes need care");
    return { chain: c.chain, status, what, routes, secondsSinceBlock: c.secondsSinceBlock };
  });
}
