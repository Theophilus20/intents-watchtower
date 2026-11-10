/**
 * @intents-watchtower/sdk — one call before every swap.
 *
 *   const wt = new Watchtower({ network: "mainnet" });
 *   if (!(await wt.isSafe("btc:bitcoin->usdc:near"))) return;   // fail-closed
 *
 * Zero dependencies. Works in Node 18+, browsers, Deno, Bun and edge runtimes.
 */

export type Status = "green" | "amber" | "unknown" | "red";

export interface SafetyCheck {
  route_id: string;
  safe: boolean;
  /** "ok" | "paused" | "override" | "no_data" | "stale" | "status" | "over_capacity" | "error" (SDK-side) */
  verdict: string;
  status: Status | null;
  score: number | null;
  /** Safe size in whole USD signed by the watchers; 0 = blocked. */
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

export interface RouteHealth {
  status: Status;
  score: number;
  capacity_usd: number;
  reasons: string[];
  epoch: number;
  report_hash: string;
  signers: number;
  updated_at_ns: string;
}

export interface CheckOptions {
  /** Maximum age of the observation behind the verdict. Default: the contract's (300s). */
  maxAgeSec?: number;
  /** Treat amber as safe. Default false. */
  allowAmber?: boolean;
}

/** Anything that can answer contract view calls: the chain, a mirror, a test double. */
export interface ViewSource {
  view<T>(method: string, args: Record<string, unknown>): Promise<T>;
}

export const NETWORKS = {
  mainnet: { rpcUrl: "https://free.rpc.fastnear.com", contractId: "watchtower.near" },
  testnet: { rpcUrl: "https://test.rpc.fastnear.com", contractId: "watchtower.testnet" },
} as const;

/**
 * rpc.mainnet.near.org and rpc.testnet.near.org are retired and answer with rate-limit errors;
 * anything still configured with them is sent to FastNEAR's free endpoints instead.
 */
export function upgradeNearRpc(url: string): string {
  const u = url.replace(/\/+$/, "");
  if (u === "https://rpc.mainnet.near.org") return NETWORKS.mainnet.rpcUrl;
  if (u === "https://rpc.testnet.near.org") return NETWORKS.testnet.rpcUrl;
  return url;
}

export interface WatchtowerOptions {
  network?: keyof typeof NETWORKS;
  rpcUrl?: string;
  contractId?: string;
  /** Use a custom source instead of NEAR RPC (local mirror, tests). */
  source?: ViewSource;
  fetch?: typeof fetch;
  /** Cache identical view calls this long. Default 5000 ms; 0 disables. */
  cacheMs?: number;
  /** Per-request timeout. Default 4000 ms. */
  timeoutMs?: number;
  /**
   * What isSafe() returns when the oracle cannot be reached. Default false (fail-closed).
   * Only set true if you knowingly prefer availability over safety.
   */
  failOpen?: boolean;
}

export class WatchtowerError extends Error {}

export class RouteUnsafeError extends Error {
  readonly check: SafetyCheck;
  constructor(check: SafetyCheck) {
    super(`Route ${check.route_id} is not safe right now (${check.verdict}${check.status ? `: ${check.status}` : ""}${check.reasons.length ? ` — ${check.reasons.join(", ")}` : ""})`);
    this.name = "RouteUnsafeError";
    this.check = check;
  }
}

/** NEAR JSON-RPC view calls with timeout. */
export class RpcSource implements ViewSource {
  constructor(
    rpcUrl: string,
    private readonly contractId: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly timeoutMs = 4000,
  ) {
    this.rpcUrl = upgradeNearRpc(rpcUrl);
  }
  private readonly rpcUrl: string;

  async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "watchtower",
          method: "query",
          params: { request_type: "call_function", finality: "optimistic", account_id: this.contractId, method_name: method, args_base64: toBase64(JSON.stringify(args)) },
        }),
      });
      if (!res.ok) throw new WatchtowerError(`RPC HTTP ${res.status}`);
      const body = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { message?: string; data?: unknown } };
      if (body.error) throw new WatchtowerError(`RPC error: ${body.error.message ?? JSON.stringify(body.error)}`);
      if (body.result?.error) throw new WatchtowerError(`Contract error: ${body.result.error}`);
      const bytes = body.result?.result;
      if (!bytes) throw new WatchtowerError("RPC returned no result");
      return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class Watchtower {
  readonly contractId: string;
  private readonly source: ViewSource;
  private readonly cacheMs: number;
  private readonly failOpen: boolean;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(opts: WatchtowerOptions = {}) {
    const net = NETWORKS[opts.network ?? "mainnet"];
    this.contractId = opts.contractId ?? net.contractId;
    this.source = opts.source ?? new RpcSource(opts.rpcUrl ?? net.rpcUrl, this.contractId, opts.fetch, opts.timeoutMs);
    this.cacheMs = opts.cacheMs ?? 5000;
    this.failOpen = opts.failOpen ?? false;
  }

  private call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const key = `${method}:${JSON.stringify(args)}`;
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < this.cacheMs) return hit.value as Promise<T>;
    const value = this.source.view<T>(method, args);
    if (this.cacheMs > 0) {
      this.cache.set(key, { at: now, value });
      value.catch(() => this.cache.delete(key));
    }
    return value;
  }

  /** Full answer with reasons. Never throws: network failures become a fail-closed "error" verdict. */
  async check(route: string, opts: CheckOptions = {}): Promise<SafetyCheck> {
    const route_id = normalizeRoute(route);
    try {
      return await this.call<SafetyCheck>("check_route", { route_id, max_age_sec: opts.maxAgeSec, allow_amber: opts.allowAmber });
    } catch (e) {
      return { route_id, safe: this.failOpen, verdict: "error", status: null, score: null, capacity_usd: null, reasons: [`ORACLE_UNREACHABLE:${(e as Error).message}`.slice(0, 120)], age_sec: null, report_hash: null };
    }
  }

  /**
   * Size-aware check: is it safe to move `amountUsd` through this route right now?
   * Fails closed: an unreachable oracle is "not allowed" unless failOpen was set.
   */
  async checkIntent(route: string, amountUsd: number, opts: CheckOptions = {}): Promise<IntentCheck> {
    const route_id = normalizeRoute(route);
    const amount_usd = Math.max(0, Math.ceil(amountUsd));
    try {
      return await this.call<IntentCheck>("check_intent", { route_id, amount_usd, max_age_sec: opts.maxAgeSec, allow_amber: opts.allowAmber });
    } catch (e) {
      return { route_id, amount_usd, allowed: this.failOpen, safe: this.failOpen, verdict: "error", status: null, score: null, capacity_usd: null, reasons: [`ORACLE_UNREACHABLE:${(e as Error).message}`.slice(0, 120)], age_sec: null, report_hash: null };
    }
  }

  /** The one-liner. True only when the route is verifiably safe right now. */
  async isSafe(route: string, opts: CheckOptions = {}): Promise<boolean> {
    return (await this.check(route, opts)).safe;
  }

  /** Throws RouteUnsafeError with the reasons when the route is not safe. */
  async assertSafe(route: string, opts: CheckOptions = {}): Promise<SafetyCheck> {
    const c = await this.check(route, opts);
    if (!c.safe) throw new RouteUnsafeError(c);
    return c;
  }

  async checkMany(routes: string[], opts: CheckOptions = {}): Promise<SafetyCheck[]> {
    return Promise.all(routes.map((r) => this.check(r, opts)));
  }

  /** Highest-scoring safe route among candidates, or null. */
  async safestRoute(candidates: string[], opts: CheckOptions = {}): Promise<string | null> {
    const checks = await this.checkMany(candidates, opts);
    let best: SafetyCheck | null = null;
    for (const c of checks) if (c.safe && (!best || (c.score ?? 0) > (best.score ?? 0))) best = c;
    return best?.route_id ?? null;
  }

  getRouteHealth(route: string): Promise<RouteHealth | null> {
    return this.call<RouteHealth | null>("get_route_health", { route_id: normalizeRoute(route) });
  }

  listRoutes(fromIndex = 0, limit = 50): Promise<[string, RouteHealth][]> {
    return this.call("list_routes", { from_index: fromIndex, limit });
  }

  clearCache(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Agent wrapper
// ---------------------------------------------------------------------------------------------

export interface GuardOptions<A extends object> extends CheckOptions {
  client: Watchtower;
  /** Methods to guard. Default: ["swap", "executeSwap", "trade", "bridge", "withdraw"]. */
  methods?: (keyof A & string)[];
  /** Extract the route from a call. Default understands {route}, {from,to}, {originAsset,destinationAsset}. */
  routeOf?: (method: string, args: unknown[]) => string | undefined;
  /** Alternative routes to try when the requested one is unsafe. Return [] to block. */
  alternatives?: (route: string, args: unknown[]) => string[];
  /** Rewrite the call's arguments for an alternative route. Required to use alternatives. */
  withRoute?: (args: unknown[], route: string) => unknown[];
  onDecision?: (d: { method: string; requested: string; used: string | null; check: SafetyCheck }) => void;
}

/**
 * Wrap any agent/tool object so every money-moving call checks Watchtower first.
 * Unsafe → reroute to the safest alternative if you provided one, otherwise throw RouteUnsafeError.
 */
export function withWatchtower<A extends object>(agent: A, opts: GuardOptions<A>): A {
  const methods = new Set<string>(opts.methods ?? ["swap", "executeSwap", "trade", "bridge", "withdraw"]);
  const routeOf = opts.routeOf ?? defaultRouteOf;
  return new Proxy(agent, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !methods.has(prop) || typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const requested = routeOf(prop, args);
        if (!requested) throw new WatchtowerError(`withWatchtower: cannot tell which route ${prop}() uses; pass routeOf`);
        const check = await opts.client.check(requested, opts);
        if (check.safe) {
          opts.onDecision?.({ method: prop, requested, used: requested, check });
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        }
        const alts = opts.alternatives?.(requested, args) ?? [];
        const alt = alts.length && opts.withRoute ? await opts.client.safestRoute(alts, opts) : null;
        opts.onDecision?.({ method: prop, requested, used: alt, check });
        if (alt && opts.withRoute) return (value as (...a: unknown[]) => unknown).apply(target, opts.withRoute(args, alt));
        throw new RouteUnsafeError(check);
      };
    },
  });
}

function defaultRouteOf(_method: string, args: unknown[]): string | undefined {
  const a = args[0];
  if (typeof a === "string" && a.includes("->")) return a;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    if (typeof o.route === "string") return o.route;
    if (typeof o.from === "string" && typeof o.to === "string") return `${o.from}->${o.to}`;
    if (typeof o.originAsset === "string" && typeof o.destinationAsset === "string") return `${o.originAsset}->${o.destinationAsset}`;
  }
  return undefined;
}

export function normalizeRoute(route: string): string {
  return route.replace(/\s+/g, "").toLowerCase();
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
