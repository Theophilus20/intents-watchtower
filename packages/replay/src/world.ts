import type {
  Advisory, AssetConfig, AssetKey, ChainConfig, ChainId, CreditEvent, DepositEvent, ObservationBatch,
  OutflowHistory, RouteId, SolverFill, WithdrawalEvent,
} from "@watchtower/core";
import { DEFAULT_ASSETS, DEFAULT_CHAINS, DEFAULT_ROUTES, Rng, fromUsdCents, indexBy, parseRoute, toUsdCents } from "@watchtower/core";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * A deterministic, statistically plausible model of NEAR Intents traffic.
 *
 * It keeps a real double-entry ledger per asset — custody (cold + hot wallet) on the home chain,
 * credited supply on NEAR, deposits in flight, withdrawals pending — so every invariant the
 * engine checks holds in normal operation and breaks *only* when a scenario breaks it.
 * Same seed, same world, on every machine: that is what lets three watchers agree on a hash.
 */

export interface AssetProfile {
  /** Credited supply at start, USD. */
  supplyUsd: number;
  /** Price at start, USD. */
  priceUsd: number;
  /** Over-collateral buffer from accumulated bridge fees (0.004 = 0.4%). */
  buffer: number;
  /** Hot wallet as a share of custody. */
  hotShare: number;
  /** Mean deposits / withdrawals per minute. */
  depositRate: number;
  withdrawRate: number;
  /** Median ticket size, USD, and lognormal spread. */
  medianUsd: number;
  sigma: number;
  /** Minutes from home-chain deposit to NEAR credit. */
  creditDelayMin: [number, number];
  /** Daily price volatility (stdev of log returns per minute is derived). */
  vol: number;
}

export const DEFAULT_PROFILES: Record<AssetKey, AssetProfile> = {
  "btc:bitcoin": { supplyUsd: 180e6, priceUsd: 96_000, buffer: 0.004, hotShare: 0.06, depositRate: 0.55, withdrawRate: 0.5, medianUsd: 4_000, sigma: 1.3, creditDelayMin: [12, 28], vol: 0.025 },
  "eth:ethereum": { supplyUsd: 90e6, priceUsd: 3_400, buffer: 0.004, hotShare: 0.1, depositRate: 0.8, withdrawRate: 0.75, medianUsd: 2_500, sigma: 1.2, creditDelayMin: [2, 4], vol: 0.03 },
  "usdc:ethereum": { supplyUsd: 120e6, priceUsd: 1, buffer: 0.003, hotShare: 0.08, depositRate: 1.0, withdrawRate: 0.95, medianUsd: 3_000, sigma: 1.2, creditDelayMin: [2, 4], vol: 0.0005 },
  "sol:solana": { supplyUsd: 40e6, priceUsd: 210, buffer: 0.004, hotShare: 0.08, depositRate: 0.8, withdrawRate: 0.75, medianUsd: 1_500, sigma: 1.2, creditDelayMin: [1, 2], vol: 0.04 },
  "usdt:bsc": { supplyUsd: 35e6, priceUsd: 1, buffer: 0.004, hotShare: 0.03, depositRate: 1.1, withdrawRate: 1.05, medianUsd: 1_200, sigma: 1.1, creditDelayMin: [1, 2], vol: 0.0005 },
  "bnb:bsc": { supplyUsd: 12e6, priceUsd: 640, buffer: 0.004, hotShare: 0.05, depositRate: 0.45, withdrawRate: 0.42, medianUsd: 1_000, sigma: 1.1, creditDelayMin: [1, 2], vol: 0.03 },
  "ltc:litecoin": { supplyUsd: 6e6, priceUsd: 92, buffer: 0.005, hotShare: 0.08, depositRate: 0.2, withdrawRate: 0.19, medianUsd: 800, sigma: 1.0, creditDelayMin: [6, 12], vol: 0.035 },
  "usdc:near": { supplyUsd: 0, priceUsd: 1, buffer: 0, hotShare: 0, depositRate: 0, withdrawRate: 0, medianUsd: 0, sigma: 1, creditDelayMin: [0, 0], vol: 0.0003 },
  "near:near": { supplyUsd: 0, priceUsd: 2.9, buffer: 0, hotShare: 0, depositRate: 0, withdrawRate: 0, medianUsd: 0, sigma: 1, creditDelayMin: [0, 0], vol: 0.04 },
};

/** Solver line-ups per route: names and relative appetite. One route is deliberately concentrated. */
export const DEFAULT_SOLVERS: Record<RouteId, { solvers: string[]; weights: number[]; ratePerMin: number }> = {};
const STD_SOLVERS = ["aurora-mm.near", "flowdesk-mm.near", "kestrel-solver.near", "tidal-labs.near", "orbit-liquidity.near", "nightjar.near", "basalt-capital.near", "lumen-arb.near"];
for (const r of DEFAULT_ROUTES) DEFAULT_SOLVERS[r] = { solvers: STD_SOLVERS, weights: [17, 15, 14, 13, 12, 11, 10, 8], ratePerMin: 0.9 };
// Thin Litecoin books: a realistic amber ("concentrated") on a normal day.
DEFAULT_SOLVERS["ltc:litecoin->btc:bitcoin"] = { solvers: ["kestrel-solver.near", "tidal-labs.near", "nightjar.near", "lumen-arb.near", "basalt-capital.near"], weights: [31, 26, 20, 13, 10], ratePerMin: 0.3 };
DEFAULT_SOLVERS["ltc:litecoin->usdc:near"] = { solvers: ["kestrel-solver.near", "flowdesk-mm.near", "tidal-labs.near", "nightjar.near", "lumen-arb.near", "aurora-mm.near"], weights: [24, 20, 18, 15, 13, 10], ratePerMin: 0.4 };

export interface WorldOptions {
  seed: string | number;
  startMs: number;
  assets?: AssetConfig[];
  chains?: ChainConfig[];
  routes?: RouteId[];
  profiles?: Record<AssetKey, AssetProfile>;
  solvers?: typeof DEFAULT_SOLVERS;
  userCount?: number;
}

interface Ledger {
  cold: bigint;
  hot: bigint;
  hotTarget: bigint;
  supply: bigint;
  pendingWithdrawals: { amount: bigint; payAtMs: number; withdrawalId: string }[];
  scheduledCredits: { atMs: number; credit: CreditEvent }[];
  refillAtMs?: number;
  priceMicro: bigint;
}

export interface AttackLog {
  atMs: number;
  usdCents: bigint;
  asset: AssetKey;
  kind: "ghost_credit" | "withdrawal";
}

export class World {
  readonly rng: Rng;
  readonly assets: AssetConfig[];
  readonly chains: ChainConfig[];
  readonly routes: RouteId[];
  readonly profiles: Record<AssetKey, AssetProfile>;
  readonly solvers: typeof DEFAULT_SOLVERS;
  readonly assetMap: Map<AssetKey, AssetConfig>;
  readonly chainMap: Map<ChainId, ChainConfig>;
  nowMs: number;
  readonly ledger = new Map<AssetKey, Ledger>();
  readonly users: string[];
  readonly attackLog: AttackLog[] = [];
  private seq = 0;
  private heads = new Map<ChainId, { height: number; timeMs: number; finality: number; reorg: number }>();
  private frozen = new Map<string, number>(); // feed key -> until
  private stalled = new Map<ChainId, number>(); // chain -> until
  private pendingAdvisories: Advisory[] = [];
  private pendingAccounts: { account: string; createdAtMs: number }[] = [];
  private queue: { credits: CreditEvent[]; deposits: DepositEvent[]; withdrawals: WithdrawalEvent[]; fills: SolverFill[] } = { credits: [], deposits: [], withdrawals: [], fills: [] };
  private disabledSolvers = new Map<RouteId, Set<string>>();
  private started = false;

  constructor(opts: WorldOptions) {
    this.rng = new Rng(opts.seed);
    this.assets = opts.assets ?? DEFAULT_ASSETS;
    this.chains = opts.chains ?? DEFAULT_CHAINS;
    this.routes = opts.routes ?? DEFAULT_ROUTES;
    this.profiles = opts.profiles ?? DEFAULT_PROFILES;
    this.solvers = opts.solvers ?? DEFAULT_SOLVERS;
    this.assetMap = indexBy(this.assets, (a) => a.key);
    this.chainMap = indexBy(this.chains, (c) => c.id);
    this.nowMs = opts.startMs;
    this.users = Array.from({ length: opts.userCount ?? 400 }, () => `${this.rng.hex(4)}${this.rng.pick(["", ".tg", ".near", ".near"])}`.replace(/^([0-9a-f]{8})$/, "$1.near"));

    for (const a of this.assets) {
      const p = this.profiles[a.key];
      if (!p) continue;
      const priceMicro = BigInt(Math.round(p.priceUsd * 1e6));
      const supply = fromUsdCents(BigInt(Math.round(p.supplyUsd * 100)), a.decimals, priceMicro);
      const custody = supply + (supply * BigInt(Math.round(p.buffer * 1e6))) / 1_000_000n;
      const hot = (custody * BigInt(Math.round(p.hotShare * 1e6))) / 1_000_000n;
      this.ledger.set(a.key, { cold: custody - hot, hot, hotTarget: hot, supply, pendingWithdrawals: [], scheduledCredits: [], priceMicro });
    }
    for (const c of this.chains) {
      this.heads.set(c.id, { height: 1_000_000 + this.rng.int(0, 1e6), timeMs: this.nowMs - this.rng.int(0, Math.min(c.blockTimeSec, 60)) * 1000, finality: c.finalityLagAmber ? 64 : 0, reorg: 0 });
    }
  }

  private id(prefix: string): string {
    return `${prefix}-${(++this.seq).toString(36)}`;
  }

  private nearTx(): string {
    return this.rng.base58(44);
  }

  private sourceTx(chain: ChainId): string {
    return chain === "bitcoin" || chain === "litecoin" ? this.rng.hex(32) : chain === "solana" ? this.rng.base58(88) : `0x${this.rng.hex(32)}`;
  }

  usdToUnits(asset: AssetKey, usd: number): bigint {
    const a = this.assetMap.get(asset)!;
    return fromUsdCents(BigInt(Math.max(0, Math.round(usd * 100))), a.decimals, this.ledger.get(asset)?.priceMicro ?? 1_000_000n);
  }

  unitsToUsdCents(asset: AssetKey, units: bigint): bigint {
    const a = this.assetMap.get(asset)!;
    return toUsdCents(units, a.decimals, this.ledger.get(asset)?.priceMicro ?? 0n);
  }

  // ---------------------------------------------------------------------------------------
  // Normal traffic
  // ---------------------------------------------------------------------------------------

  /** A user deposits on the home chain; the bridge credits them on NEAR a few minutes later. */
  deposit(asset: AssetKey, usd: number, account = this.rng.pick(this.users), atMs = this.nowMs): void {
    const a = this.assetMap.get(asset)!;
    const l = this.ledger.get(asset)!;
    const p = this.profiles[asset]!;
    const amount = this.usdToUnits(asset, usd);
    if (amount <= 0n) return;
    const sourceTx = this.sourceTx(a.chain);
    const dep: DepositEvent = { id: this.id("dep"), asset, amount, account: this.rng.chance(0.85) ? account : undefined, sourceTx, atMs };
    this.queue.deposits.push(dep);
    l.cold += amount;
    const fee = (amount * 5n) / 10_000n; // 0.05% bridge fee stays in custody
    const credit: CreditEvent = {
      id: this.id("crd"), asset, amount: amount - fee, account, nearTx: this.nearTx(),
      atMs: atMs + this.rng.int(p.creditDelayMin[0] * 60, p.creditDelayMin[1] * 60) * 1000,
      sourceTxRef: this.rng.chance(0.6) ? sourceTx : undefined,
    };
    l.scheduledCredits.push({ atMs: credit.atMs, credit });
  }

  /** A user withdraws to the home chain: burned on NEAR now, paid from the hot wallet shortly after. */
  withdraw(asset: AssetKey, units: bigint, account = this.rng.pick(this.users), opts: { payDelayMs?: number; attack?: boolean } = {}): WithdrawalEvent | undefined {
    const a = this.assetMap.get(asset)!;
    const l = this.ledger.get(asset)!;
    if (units <= 0n || units > l.supply) return undefined;
    const w: WithdrawalEvent = { id: this.id("wd"), asset, amount: units, account, nearTx: this.nearTx(), destChain: a.chain, atMs: this.nowMs };
    l.supply -= units;
    l.pendingWithdrawals.push({ amount: units, payAtMs: this.nowMs + (opts.payDelayMs ?? this.rng.int(30, 150) * 1000), withdrawalId: w.id });
    this.queue.withdrawals.push(w);
    if (opts.attack) this.attackLog.push({ atMs: this.nowMs, usdCents: this.unitsToUsdCents(asset, units), asset, kind: "withdrawal" });
    return w;
  }

  // ---------------------------------------------------------------------------------------
  // Scenario hooks
  // ---------------------------------------------------------------------------------------

  /** The October 2026 failure mode: balance appears on NEAR with nothing deposited behind it. */
  ghostCredit(asset: AssetKey, usd: number, account: string): CreditEvent {
    const l = this.ledger.get(asset)!;
    const amount = this.usdToUnits(asset, usd);
    const credit: CreditEvent = { id: this.id("crd"), asset, amount, account, nearTx: this.nearTx(), atMs: this.nowMs };
    l.supply += amount;
    this.queue.credits.push(credit);
    this.attackLog.push({ atMs: this.nowMs, usdCents: this.unitsToUsdCents(asset, amount), asset, kind: "ghost_credit" });
    return credit;
  }

  createAccount(account: string, createdAtMs = this.nowMs): void {
    this.pendingAccounts.push({ account, createdAtMs });
  }

  advisory(adv: Omit<Advisory, "id"> & { id?: string }): void {
    this.pendingAdvisories.push({ id: adv.id ?? this.id("adv"), ...adv });
  }

  reorg(chain: ChainId, depth: number): void {
    this.heads.get(chain)!.reorg = depth;
  }

  stallChain(chain: ChainId, untilMs: number): void {
    this.stalled.set(chain, untilMs);
  }

  /** Stop a feed ("custody:btc:bitcoin", "supply:...", "chain:bitcoin", "price:...") until a time. */
  freeze(feed: string, untilMs: number): void {
    this.frozen.set(feed, untilMs);
  }

  setPrice(asset: AssetKey, usd: number): void {
    this.ledger.get(asset)!.priceMicro = BigInt(Math.round(usd * 1e6));
  }

  disableSolver(route: RouteId, solver: string): void {
    const set = this.disabledSolvers.get(route) ?? new Set<string>();
    set.add(solver);
    this.disabledSolvers.set(route, set);
  }

  private isFrozen(feed: string): boolean {
    const until = this.frozen.get(feed);
    return until !== undefined && this.nowMs < until;
  }

  // ---------------------------------------------------------------------------------------
  // Clock
  // ---------------------------------------------------------------------------------------

  /** Pre-history so baselines and 24h concentration windows are warm from minute one. */
  private preroll(batch: ObservationBatch): void {
    const history: OutflowHistory[] = [];
    const startHour = Math.floor(this.nowMs / HOUR) * HOUR;
    for (const a of this.assets) {
      const p = this.profiles[a.key];
      if (!p || p.withdrawRate === 0) continue;
      for (let h = 1; h <= 720; h++) {
        const n = this.rng.poisson(p.withdrawRate * 60);
        let usd = 0;
        for (let i = 0; i < n; i++) usd += Math.min(this.rng.logNormal(p.medianUsd, p.sigma), 400_000);
        history.push({ asset: a.key, hourStartMs: startHour - h * HOUR, usdCents: BigInt(Math.round(usd * 100)) });
      }
    }
    batch.outflowHistory = history;
    const fills: SolverFill[] = [];
    for (const r of this.routes) {
      const s = this.solvers[r];
      if (!s) continue;
      for (let m = 24 * 60; m > 0; m -= 10) {
        const n = this.rng.poisson(s.ratePerMin * 10);
        for (let i = 0; i < n; i++) {
          fills.push({ id: this.id("fill"), route: r, solver: this.rng.weighted(s.solvers, s.weights), usdCents: BigInt(Math.round(this.rng.logNormal(2_000, 0.9) * 100)), atMs: this.nowMs - m * MIN + this.rng.int(0, 599) * 1000 });
        }
      }
    }
    batch.fills = fills;
    batch.accounts = this.users.map((u) => ({ account: u, createdAtMs: this.nowMs - this.rng.int(20, 900) * 24 * HOUR }));
  }

  /**
   * Advance one step and return everything collectors would have seen during it.
   * `during` runs after the clock moves and before settlement, so scenario events are stamped
   * inside this step exactly like organic traffic.
   */
  tick(stepMs = MIN, during?: (w: World) => void): ObservationBatch {
    const batch: ObservationBatch = { asOfMs: this.nowMs };
    if (!this.started) {
      this.started = true;
      this.preroll(batch);
      during?.(this);
    } else {
      this.nowMs += stepMs;
      batch.asOfMs = this.nowMs;
      this.simulateTraffic(stepMs);
      during?.(this);
    }
    const t = this.nowMs;

    // Settle: scheduled credits land, pending withdrawals pay out, hot wallets refill.
    for (const [asset, l] of this.ledger) {
      const due = l.scheduledCredits.filter((c) => c.atMs <= t);
      l.scheduledCredits = l.scheduledCredits.filter((c) => c.atMs > t);
      for (const { credit } of due) {
        l.supply += credit.amount;
        this.queue.credits.push(credit);
      }
      const paying = l.pendingWithdrawals.filter((p) => p.payAtMs <= t);
      l.pendingWithdrawals = l.pendingWithdrawals.filter((p) => p.payAtMs > t);
      for (const p of paying) {
        if (l.hot >= p.amount) l.hot -= p.amount;
        else {
          // Hot wallet short: operator tops up from cold to pay (slow path).
          const short = p.amount - l.hot;
          l.hot = 0n;
          l.cold -= short;
        }
      }
      if (l.hotTarget > 0n && l.hot * 10n < l.hotTarget * 4n && l.refillAtMs === undefined) l.refillAtMs = t + 10 * MIN;
      if (l.refillAtMs !== undefined && t >= l.refillAtMs) {
        const move = l.hotTarget - l.hot;
        if (move > 0n && l.cold >= move) {
          l.cold -= move;
          l.hot += move;
        }
        l.refillAtMs = undefined;
      }
      void asset;
    }

    // Chains
    batch.chains = [];
    for (const c of this.chains) {
      const h = this.heads.get(c.id)!;
      const stalledUntil = this.stalled.get(c.id);
      if (!(stalledUntil !== undefined && t < stalledUntil)) {
        const lambda = (stepMs / 1000) / c.blockTimeSec;
        const blocks = c.blockTimeSec >= 60 ? this.rng.poisson(lambda) : Math.round(lambda);
        if (blocks > 0) {
          h.height += blocks;
          h.timeMs = c.blockTimeSec >= 60 ? t - this.rng.int(0, Math.floor(stepMs / 1000 / Math.max(1, blocks))) * 1000 : t - this.rng.int(0, Math.min(c.blockTimeSec, 5)) * 1000;
        }
      }
      if (!this.isFrozen(`chain:${c.id}`)) {
        batch.chains.push({ chain: c.id, headHeight: h.height, headTimeMs: Math.min(h.timeMs, t), finalityLagBlocks: c.finalityLagAmber ? 64 + this.rng.int(0, 10) : undefined, reorgDepth: h.reorg, atMs: t });
      }
    }

    // Prices (geometric random walk)
    batch.prices = [];
    for (const a of this.assets) {
      const p = this.profiles[a.key];
      const l = this.ledger.get(a.key);
      if (!p) continue;
      const priceMicro = l?.priceMicro ?? BigInt(Math.round(p.priceUsd * 1e6));
      let next = priceMicro;
      if (a.stable) {
        // Mean-reverting around whatever the scenario set (normally $1.00)
        const jitter = BigInt(Math.round(this.rng.normal(0, 150)));
        next = priceMicro + jitter;
        if (next > 1_000_000n + 2_000n && !this.depegged.has(a.key)) next = 1_000_000n + 2_000n;
        if (next < 1_000_000n - 2_000n && !this.depegged.has(a.key)) next = 1_000_000n - 2_000n;
      } else {
        const sd = p.vol / Math.sqrt(1440);
        next = BigInt(Math.max(1, Math.round(Number(priceMicro) * Math.exp(this.rng.normal(0, sd)))));
      }
      if (l) l.priceMicro = next;
      if (!this.isFrozen(`price:${a.key}`)) batch.prices.push({ asset: a.key, priceMicroUsd: next, atMs: t });
    }

    // Balances
    batch.supply = [];
    batch.custody = [];
    batch.hotWallets = [];
    for (const a of this.assets) {
      const l = this.ledger.get(a.key);
      if (!l || a.bridge === "native") continue;
      const pending = l.pendingWithdrawals.reduce((s, p) => s + p.amount, 0n);
      if (!this.isFrozen(`supply:${a.key}`)) batch.supply.push({ asset: a.key, credited: l.supply, pendingWithdrawals: pending, atMs: t });
      if (!this.isFrozen(`custody:${a.key}`)) {
        batch.custody.push({ asset: a.key, balance: l.cold + l.hot, atMs: t });
        batch.hotWallets.push({ asset: a.key, address: hotWalletAddress(a), balance: l.hot, atMs: t });
      }
    }

    // Flush events
    batch.credits = this.queue.credits;
    batch.deposits = this.queue.deposits;
    batch.withdrawals = this.queue.withdrawals;
    batch.fills = [...(batch.fills ?? []), ...this.queue.fills];
    batch.advisories = this.pendingAdvisories;
    batch.accounts = [...(batch.accounts ?? []), ...this.pendingAccounts];
    this.queue = { credits: [], deposits: [], withdrawals: [], fills: [] };
    this.pendingAdvisories = [];
    this.pendingAccounts = [];
    return batch;
  }

  private depegged = new Set<AssetKey>();
  depeg(asset: AssetKey, usd: number): void {
    this.depegged.add(asset);
    this.setPrice(asset, usd);
  }

  private simulateTraffic(stepMs: number): void {
    const minutes = stepMs / MIN;
    for (const a of this.assets) {
      const p = this.profiles[a.key];
      if (!p || a.bridge === "native") continue;
      const nd = this.rng.poisson(p.depositRate * minutes);
      for (let i = 0; i < nd; i++) this.deposit(a.key, Math.min(this.rng.logNormal(p.medianUsd, p.sigma), 400_000), undefined, this.nowMs - this.rng.int(0, 59) * 1000);
      const nw = this.rng.poisson(p.withdrawRate * minutes);
      for (let i = 0; i < nw; i++) this.withdraw(a.key, this.usdToUnits(a.key, Math.min(this.rng.logNormal(p.medianUsd, p.sigma), 400_000)));
    }
    for (const r of this.routes) {
      const s = this.solvers[r];
      if (!s) continue;
      const disabled = this.disabledSolvers.get(r);
      const solvers = s.solvers.filter((x) => !disabled?.has(x));
      const weights = s.solvers.map((x, i) => (disabled?.has(x) ? -1 : s.weights[i]!)).filter((w) => w >= 0);
      if (solvers.length === 0) continue;
      const n = this.rng.poisson(s.ratePerMin * minutes);
      for (let i = 0; i < n; i++) {
        this.queue.fills.push({ id: this.id("fill"), route: r, solver: this.rng.weighted(solvers, weights), usdCents: BigInt(Math.round(this.rng.logNormal(2_000, 0.9) * 100)), atMs: this.nowMs - this.rng.int(0, 59) * 1000 });
      }
    }
  }

  /** Backing ratio straight from the ledger (ground truth for tests). */
  trueBackingPpm(asset: AssetKey): number {
    const l = this.ledger.get(asset)!;
    const pending = l.pendingWithdrawals.reduce((s, p) => s + p.amount, 0n);
    const inflight = l.scheduledCredits.reduce((s, c) => s + c.credit.amount, 0n);
    return Number(((l.cold + l.hot) * 1_000_000n) / (l.supply + pending + inflight));
  }

  routeAssetsOf(route: RouteId): AssetKey[] {
    const r = parseRoute(route);
    return [r.src, r.dst];
  }
}

export function hotWalletAddress(a: AssetConfig): string {
  switch (a.chain) {
    case "bitcoin": return "bc1q-sim-hot-btc";
    case "litecoin": return "ltc1q-sim-hot-ltc";
    case "solana": return "SimHotSo1ana1111111111111111111111111111111";
    default: return `0xsim-hot-${a.symbol}-${a.chain}`;
  }
}
