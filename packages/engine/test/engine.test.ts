import { describe, expect, it } from "vitest";
import type { ObservationBatch, RouteVerdict } from "@watchtower/core";
import { DEFAULT_ASSETS, DEFAULT_CHAINS } from "@watchtower/core";
import { ENGINE_VERSION, RiskEngine, defaultConfig, verifyVerdict, type EngineConfig } from "@watchtower/engine";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const ROUTE = "usdt:bsc->usdc:near";
const E18 = 10n ** 18n;
const usdt = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // 18 decimals

function cfg(over: Partial<EngineConfig> = {}): EngineConfig {
  return defaultConfig({
    assets: DEFAULT_ASSETS.filter((a) => a.key === "usdt:bsc" || a.key === "usdc:near"),
    chains: DEFAULT_CHAINS.filter((c) => c.id === "bsc" || c.id === "near"),
    routes: [ROUTE],
    ...over,
  });
}

/** A healthy minute: $10M credited, $10.05M in custody, fresh chains and prices, competitive fills. */
function healthy(t: number, over: Partial<ObservationBatch> = {}, supply = usdt(10_000_000), custody = usdt(10_050_000)): ObservationBatch {
  return {
    asOfMs: t,
    supply: [{ asset: "usdt:bsc", credited: supply, pendingWithdrawals: 0n, atMs: t }],
    custody: [{ asset: "usdt:bsc", balance: custody, atMs: t }],
    prices: [
      { asset: "usdt:bsc", priceMicroUsd: 1_000_000n, atMs: t },
      { asset: "usdc:near", priceMicroUsd: 1_000_000n, atMs: t },
    ],
    chains: [
      { chain: "bsc", headHeight: Math.floor(t / 1000), headTimeMs: t - 1000, atMs: t },
      { chain: "near", headHeight: Math.floor(t / 1000), headTimeMs: t - 500, atMs: t },
    ],
    ...over,
  };
}

function competitiveFills(t: number) {
  const solvers = ["a.near", "b.near", "c.near", "d.near", "e.near", "f.near", "g.near", "h.near"];
  return Array.from({ length: 40 }, (_, i) => ({ id: `f${i}`, route: ROUTE, solver: solvers[i % 8]!, usdCents: 100_000n, atMs: t - i * MIN }));
}

function verdict(e: RiskEngine, t: number): RouteVerdict {
  return e.evaluate(t).routes[0]!;
}

describe("proof of backing", () => {
  it("is green when custody covers credited supply", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { fills: competitiveFills(T0) }));
    const v = verdict(e, T0);
    expect(v.status).toBe("green");
    const backing = v.components.find((c) => c.check === "backing")!;
    expect(backing.metrics.backing_ppm).toBe(1_005_000);
  });

  it("goes red below 99.5% and amber inside the tolerance band", () => {
    const red = new RiskEngine(cfg());
    red.ingest(healthy(T0, {}, usdt(10_000_000), usdt(9_900_000)));
    expect(verdict(red, T0).reasons).toContain("BACKING_BELOW_THRESHOLD:usdt:bsc");
    expect(verdict(red, T0).status).toBe("red");

    const amber = new RiskEngine(cfg());
    amber.ingest(healthy(T0, { fills: competitiveFills(T0) }, usdt(10_000_000), usdt(9_970_000)));
    const v = verdict(amber, T0);
    expect(v.status).toBe("amber");
    expect(v.reasons).toContain("BACKING_TOLERANCE:usdt:bsc");
  });

  it("ignores an ordinary withdrawal dip when the cushion is wide, but not one heading for 100%", () => {
    const backingOf = (e: RiskEngine, t: number) => verdict(e, t).components.find((c) => c.check === "backing")!;
    // 107.7% -> 107.4%: a large payout leaving custody a few minutes after its burn on NEAR.
    const wide = new RiskEngine(cfg());
    wide.step(healthy(T0, { fills: competitiveFills(T0) }, usdt(10_000_000), usdt(10_770_000)));
    wide.ingest(healthy(T0 + MIN, { fills: competitiveFills(T0 + MIN) }, usdt(10_000_000), usdt(10_740_000)));
    expect(backingOf(wide, T0 + MIN).status).toBe("green");
    // 100.8% -> 100.3%: the same kind of fall, but two more like it cross the line.
    const thin = new RiskEngine(cfg());
    thin.step(healthy(T0, { fills: competitiveFills(T0) }, usdt(10_000_000), usdt(10_080_000)));
    thin.ingest(healthy(T0 + MIN, { fills: competitiveFills(T0 + MIN) }, usdt(10_000_000), usdt(10_030_000)));
    expect(backingOf(thin, T0 + MIN).status).toBe("amber");
    expect(backingOf(thin, T0 + MIN).reasons).toContain("BACKING_DROP_FAST:usdt:bsc");
  });

  it("doesn't call a spike's return to normal a fall, but still catches a steady drain", () => {
    const backingOf = (e: RiskEngine, t: number) => verdict(e, t).components.find((c) => c.check === "backing")!;
    // Seen live on SOL: 101.6% for minutes, one reading at 102.0% (a payout not yet sent), back to 101.6%.
    const spike = new RiskEngine(cfg());
    const levels = [10_160_000, 10_160_000, 10_160_000, 10_200_000, 10_162_000, 10_162_000];
    levels.forEach((c, i) => {
      spike.ingest(healthy(T0 + i * MIN, { fills: competitiveFills(T0 + i * MIN) }, usdt(10_000_000), usdt(c)));
      expect(backingOf(spike, T0 + i * MIN).status).toBe("green");
    });
    // A drain: 101.6% falling 0.15% a minute. It is caution well before it reaches 100%.
    const drain = new RiskEngine(cfg());
    let caution = -1;
    for (let i = 0; i < 10; i++) {
      drain.ingest(healthy(T0 + i * MIN, { fills: competitiveFills(T0 + i * MIN) }, usdt(10_000_000), usdt(10_160_000 - i * 15_000)));
      const b = backingOf(drain, T0 + i * MIN);
      if (caution < 0 && b.reasons.includes("BACKING_DROP_FAST:usdt:bsc")) caution = i;
    }
    expect(caution).toBeGreaterThan(0);
    expect(10_160_000 - caution * 15_000).toBeGreaterThan(10_050_000);
  });

  it("doesn't call a long-pending withdrawal's collection a fall (seen live on HOT's USDT)", () => {
    const backingOf = (e: RiskEngine, t: number) => verdict(e, t).components.find((c) => c.check === "backing")!;
    // 100.05% for 80 minutes; a big withdrawal taken off NEAR lifts it to 100.35% for 40 minutes
    // until the user collects it on BSC, and it settles back at 100.07%.
    const e = new RiskEngine(cfg());
    const level = (i: number) => (i < 80 ? 10_005_000 : i < 120 ? 10_035_000 : 10_007_000);
    for (let i = 0; i <= 120; i++) {
      e.ingest(healthy(T0 + i * MIN, { fills: competitiveFills(T0 + i * MIN) }, usdt(10_000_000), usdt(level(i))));
      const b = backingOf(e, T0 + i * MIN);
      expect(b.reasons.some((r) => r.startsWith("BACKING_DROP_FAST")), `minute ${i}`).toBe(false);
    }
  });

  it("partly verified: never green while short, red when the shortfall grows", () => {
    // $10M owed, $9.75M in the treasury: a steady $250k shortfall measured from history.
    const partial = [{ asset: "usdt:bsc", baselineGap: usdt(250_000), smallGap: usdt(5_000), alarmGap: usdt(400_000), persistMs: 60 * MIN, sinceMs: T0 - 180 * 24 * 60 * MIN }];
    const at = (e: RiskEngine, i: number, custody: number) => {
      e.ingest(healthy(T0 + i * MIN, { fills: competitiveFills(T0 + i * MIN), partialBacking: partial }, usdt(10_000_000), usdt(custody)));
      return verdict(e, T0 + i * MIN);
    };
    const steady = new RiskEngine(cfg());
    const v = at(steady, 0, 9_750_000);
    expect(v.status).toBe("unknown");
    expect(v.reasons).toContain("BACKING_PARTIAL:usdt:bsc");
    expect(v.reasons.some((r) => r.startsWith("BACKING_BELOW_THRESHOLD"))).toBe(false);
    const b = v.components.find((c) => c.check === "backing")!;
    expect(b.metrics.deficit).toBe(usdt(250_000).toString());
    // A deposit credited before it is swept raises the shortfall for a while: still partly verified.
    for (let i = 1; i <= 30; i++) expect(at(steady, i, 9_650_000).status).toBe("unknown");
    // Swept: back to the usual level, and the clock resets.
    expect(at(steady, 31, 9_750_000).reasons).toContain("BACKING_PARTIAL:usdt:bsc");

    // Past anything history showed: red at once.
    const jump = new RiskEngine(cfg());
    at(jump, 0, 9_750_000);
    const r = at(jump, 1, 9_500_000);
    expect(r.status).toBe("red");
    expect(r.reasons).toContain("BACKING_GAP_GROWN:usdt:bsc");

    // A smaller loss that never comes back: red once it outlasts any sweep delay seen.
    const slow = new RiskEngine(cfg());
    let firstRed = -1;
    for (let i = 0; i <= 90; i++) if (at(slow, i, i === 0 ? 9_750_000 : 9_700_000).status === "red" && firstRed < 0) firstRed = i;
    expect(firstRed).toBe(62);

    // Topped back up to the full amount: judged like any other asset again.
    const full = new RiskEngine(cfg());
    expect(at(full, 0, 10_050_000).reasons.some((x) => x.startsWith("BACKING_PARTIAL"))).toBe(false);
  });

  it("says custody isn't set up, rather than stale, when no addresses are configured", () => {
    const e = new RiskEngine(cfg());
    const b = healthy(T0, { custodyConfigured: [] });
    delete b.custody;
    e.ingest(b);
    expect(verdict(e, T0).reasons).toContain("CUSTODY_NOT_CONFIGURED:usdt:bsc");
    expect(verdict(e, T0).reasons.some((r) => r.startsWith("CUSTODY_DATA_STALE"))).toBe(false);
    const f = new RiskEngine(cfg());
    const c = healthy(T0, { custodyConfigured: ["usdt:bsc"] });
    delete c.custody;
    f.ingest(c);
    expect(verdict(f, T0).reasons).toContain("CUSTODY_DATA_STALE:usdt:bsc");
  });

  it("counts in-flight deposits as liabilities, not assets", () => {
    const e = new RiskEngine(cfg());
    // $1M deposit already in custody (10.05M + 1M) but not yet credited: backing stays ~100.5%, not 110%.
    e.ingest(healthy(T0, { deposits: [{ id: "d1", asset: "usdt:bsc", amount: usdt(1_000_000), sourceTx: "0xabc", atMs: T0 }] }, usdt(10_000_000), usdt(11_050_000)));
    const b = verdict(e, T0).components.find((c) => c.check === "backing")!;
    expect(b.metrics.backing_ppm).toBe(1_004_545);
    expect(b.metrics.in_flight_deposits).toBe(usdt(1_000_000).toString());
  });

  it("fails closed to unknown when custody data goes stale", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0));
    const later = T0 + 11 * MIN;
    const { custody: _drop, ...rest } = healthy(later);
    e.ingest(rest);
    const v = verdict(e, later);
    expect(v.status).toBe("unknown");
    expect(v.reasons).toContain("CUSTODY_DATA_STALE:usdt:bsc");
  });
});

describe("ghost-credit detector", () => {
  const credit = (id: string, amount: bigint, atMs: number, account = "alice.near", sourceTxRef?: string) => ({ id, asset: "usdt:bsc", amount, account, nearTx: `tx-${id}`, atMs, sourceTxRef });

  it("matches a credit to its deposit (exact tx ref beats a closer amount)", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, {
      deposits: [
        { id: "d-close", asset: "usdt:bsc", amount: usdt(1000), sourceTx: "0xclose", atMs: T0 - MIN },
        { id: "d-ref", asset: "usdt:bsc", amount: usdt(1002), sourceTx: "0xref", atMs: T0 - 2 * MIN },
      ],
      credits: [credit("c1", usdt(999.5), T0, "alice.near", "0xref")],
    }));
    expect(e.state.credits[0]!.matchedDepositId).toBe("d-ref");
  });

  it("never calls a credit a ghost when the watcher can't see that bridge's deposits", () => {
    const e = new RiskEngine(cfg());
    // A live watcher declares which assets' deposits it observes; usdt:bsc is not one of them.
    e.ingest(healthy(T0, { credits: [credit("c1", usdt(500_000), T0)], depositFeeds: [] }));
    const later = T0 + 60 * MIN;
    e.ingest(healthy(later, { depositFeeds: [] }));
    const g = verdict(e, later).components.find((x) => x.check === "ghost")!;
    expect(g.status).toBe("green");
    expect(g.reasons).toEqual(["GHOST_UNCHECKED:usdt:bsc"]);
    // The same credit, with deposits observed and none arriving, is a ghost.
    const f = new RiskEngine(cfg());
    f.ingest(healthy(T0, { credits: [credit("c1", usdt(500_000), T0)], depositFeeds: ["usdt:bsc"] }));
    f.ingest(healthy(later, { depositFeeds: ["usdt:bsc"] }));
    expect(verdict(f, later).components.find((x) => x.check === "ghost")!.reasons).toContain("GHOST_CREDIT:usdt:bsc");
  });

  it("refuses matches that break fee tolerance or name a different account", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, {
      deposits: [
        { id: "d1", asset: "usdt:bsc", amount: usdt(100_000), account: "bob.near", sourceTx: "0x1", atMs: T0 - MIN },
        { id: "d2", asset: "usdt:bsc", amount: usdt(200_000), sourceTx: "0x2", atMs: T0 - MIN },
      ],
      credits: [credit("c1", usdt(100_000), T0, "alice.near"), credit("c2", usdt(150_000), T0, "carol.near")],
    }));
    expect(e.state.credits.every((c) => !c.matchedDepositId)).toBe(true);
  });

  it("does not judge inside the grace period, goes red when an unbacked credit is withdrawn", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { fills: competitiveFills(T0), credits: [credit("ghost", usdt(50_000), T0, "mallory.near")] }, usdt(10_050_000), usdt(10_050_000)));
    expect(verdict(e, T0).reasons.some((r) => r.startsWith("GHOST"))).toBe(false);
    e.ingest(healthy(T0 + 2 * MIN, { withdrawals: [{ id: "w1", asset: "usdt:bsc", amount: usdt(49_000), account: "mallory.near", nearTx: "tx-w1", destChain: "bsc", atMs: T0 + 2 * MIN }] }, usdt(10_001_000), usdt(10_050_000)));
    expect(verdict(e, T0 + 2 * MIN).reasons.some((r) => r.startsWith("GHOST"))).toBe(false); // still inside 3m grace
    e.ingest(healthy(T0 + 4 * MIN, {}, usdt(10_001_000), usdt(10_001_000)));
    const v = verdict(e, T0 + 4 * MIN);
    expect(v.status).toBe("red");
    expect(v.reasons[0]).toBe("GHOST_CREDIT_WITHDRAWN:usdt:bsc");
    const ghost = v.components.find((c) => c.check === "ghost")!;
    expect(ghost.evidence.some((x) => x.ref === "tx-ghost")).toBe(true);
  });

  it("goes red when a credit's deposit never arrives within the chain window", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { credits: [credit("c", usdt(5_000), T0)] }, usdt(10_005_000), usdt(10_055_000)));
    const t = T0 + 6 * MIN; // BSC window is 5 minutes
    e.ingest(healthy(t, {}, usdt(10_005_000), usdt(10_055_000)));
    expect(verdict(e, t).reasons).toContain("GHOST_CREDIT:usdt:bsc");
  });

  it("clears when the deposit shows up late (observer lag)", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { fills: competitiveFills(T0), credits: [credit("c", usdt(20_000), T0)] }, usdt(10_020_000), usdt(10_070_000)));
    e.ingest(healthy(T0 + 2 * MIN, { deposits: [{ id: "late", asset: "usdt:bsc", amount: usdt(20_010), sourceTx: "0xlate", atMs: T0 - 30_000 }] }, usdt(10_020_000), usdt(10_070_000)));
    expect(e.state.credits[0]!.matchedDepositId).toBe("late");
    expect(verdict(e, T0 + 4 * MIN).reasons.some((r) => r.startsWith("GHOST"))).toBe(false);
  });
});

describe("flow anomalies: the two-signal rule", () => {
  const history = Array.from({ length: 48 }, (_, h) => ({ asset: "usdt:bsc", hourStartMs: T0 - (h + 1) * 3_600_000, usdCents: 5_000_000n + BigInt((h % 5) * 200_000) }));

  it("one extreme signal is amber, never red", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { fills: competitiveFills(T0), outflowHistory: history, accounts: [{ account: "whale.near", createdAtMs: T0 - 400 * 86_400_000 }] }));
    e.ingest(healthy(T0 + MIN, { withdrawals: [{ id: "big", asset: "usdt:bsc", amount: usdt(2_000_000), account: "whale.near", nearTx: "tx", destChain: "bsc", atMs: T0 + MIN }] }, usdt(8_000_000), usdt(8_050_000)));
    const a = verdict(e, T0 + MIN).components.find((c) => c.check === "anomaly")!;
    expect(a.reasons).toEqual(["OUTFLOW_SPIKE:usdt:bsc"]);
    expect(a.metrics.extreme).toBe(1);
    expect(a.status).toBe("amber");
  });

  it("two independent signals are red", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { outflowHistory: history, accounts: [{ account: "fresh.near", createdAtMs: T0 - 3_600_000 }] }));
    e.ingest(healthy(T0 + MIN, { withdrawals: [{ id: "w", asset: "usdt:bsc", amount: usdt(600_000), account: "fresh.near", nearTx: "tx", destChain: "bsc", atMs: T0 + MIN }] }, usdt(9_400_000), usdt(9_450_000)));
    const a = verdict(e, T0 + MIN).components.find((c) => c.check === "anomaly")!;
    expect(a.reasons).toEqual(expect.arrayContaining(["OUTFLOW_SPIKE:usdt:bsc", "FRESH_ACCOUNT_EXIT:usdt:bsc"]));
    expect(a.status).toBe("red");
  });

  it("detects a hot wallet drain", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { hotWallets: [{ asset: "usdt:bsc", address: "0xhot", balance: usdt(1_000_000), atMs: T0 }] }));
    e.ingest(healthy(T0 + 5 * MIN, { hotWallets: [{ asset: "usdt:bsc", address: "0xhot", balance: usdt(500_000), atMs: T0 + 5 * MIN }] }));
    const a = verdict(e, T0 + 5 * MIN).components.find((c) => c.check === "anomaly")!;
    expect(a.metrics.hot_wallet_drop_ppm).toBe(500_000);
    expect(a.reasons).toContain("HOT_WALLET_DRAIN:usdt:bsc");
  });
});

describe("solver concentration", () => {
  it("computes HHI and flags a one-solver route", () => {
    const e = new RiskEngine(cfg());
    const fills = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, route: ROUTE, solver: i < 17 ? "big.near" : "small.near", usdCents: 100_000n, atMs: T0 - i * MIN }));
    e.ingest(healthy(T0, { fills }));
    const c = verdict(e, T0).components.find((x) => x.check === "concentration")!;
    expect(c.metrics.hhi).toBe(8500 * 8500 / 10_000 + 1500 * 1500 / 10_000);
    expect(c.metrics.top_solver).toBe("big.near");
    expect(c.status).toBe("red");
    expect(c.reasons).toEqual(["SINGLE_SOLVER_ROUTE:usdt:bsc->usdc:near"]);
  });
  it("marks too-few fills as informational, not a failure", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0));
    const c = verdict(e, T0).components.find((x) => x.check === "concentration")!;
    expect(c.status).toBe("green");
    expect(c.reasons).toEqual(["LOW_ACTIVITY:usdt:bsc->usdc:near"]);
  });
});

describe("chain health and contagion", () => {
  it("a stalled dependency turns the route red and is listed as contagion", () => {
    const e = new RiskEngine(cfg());
    const b = healthy(T0, { fills: competitiveFills(T0) });
    b.chains![0] = { chain: "bsc", headHeight: 1, headTimeMs: T0 - 400_000, atMs: T0 };
    e.ingest(b);
    const r = e.evaluate(T0);
    expect(r.routes[0]!.status).toBe("red");
    expect(r.routes[0]!.reasons).toContain("CHAIN_STALLED:bsc");
    expect(r.contagionMap).toEqual({ bsc: [ROUTE] });
  });
  it("a watcher that missed readings never reports a stall the chain didn't have", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { fills: competitiveFills(T0) }));
    // Four minutes later the watcher couldn't read any chain (slow round, dropped connection).
    const later = T0 + 4 * MIN;
    e.ingest({ asOfMs: later });
    const r = e.evaluate(later);
    expect(r.routes[0]!.reasons.some((x) => x.startsWith("CHAIN_STALLED") || x.startsWith("CHAIN_SLOW"))).toBe(false);
    // Once the last reading is too old to trust, the answer is "unknown", still not red.
    e.ingest({ asOfMs: T0 + 6 * MIN });
    const r2 = e.evaluate(T0 + 6 * MIN);
    expect(r2.routes[0]!.reasons.some((x) => x.startsWith("CHAIN_DATA_STALE"))).toBe(true);
    expect(r2.routes[0]!.reasons.some((x) => x.startsWith("CHAIN_STALLED"))).toBe(false);
  });
  it("an active advisory is red even when the chain itself looks fine; it expires on time", () => {
    const e = new RiskEngine(cfg());
    e.ingest(healthy(T0, { fills: competitiveFills(T0), advisories: [{ id: "a1", chain: "bsc", severity: "red", title: "client bug", fromMs: T0, untilMs: T0 + 10 * MIN }] }));
    expect(verdict(e, T0).reasons).toContain("CHAIN_ADVISORY:bsc");
    e.ingest(healthy(T0 + 10 * MIN));
    expect(e.evaluate(T0 + 10 * MIN).chains.find((c) => c.subject === "bsc")!.status).toBe("green");
  });
  it("flags stablecoin depegs", () => {
    const e = new RiskEngine(cfg());
    const b = healthy(T0, { fills: competitiveFills(T0) });
    b.prices![0] = { asset: "usdt:bsc", priceMicroUsd: 962_000n, atMs: T0 };
    e.ingest(b);
    expect(verdict(e, T0).reasons).toContain("ASSET_DEPEG:usdt:bsc");
  });
});

describe("hysteresis", () => {
  it("escalates instantly and recovers one level per N clean steps", () => {
    const e = new RiskEngine(cfg());
    const statuses: string[] = [];
    for (let m = 0; m < 10; m++) {
      const t = T0 + m * MIN;
      const bad = m === 1;
      const b = healthy(t, m === 0 ? { fills: competitiveFills(t) } : {});
      if (bad) b.prices![0] = { asset: "usdt:bsc", priceMicroUsd: 950_000n, atMs: t };
      e.ingest(b);
      statuses.push(verdict(e, t).status);
    }
    expect(statuses).toEqual(["green", "red", "red", "red", "amber", "amber", "amber", "green", "green", "green"]);
  });
});

describe("determinism and verifiability", () => {
  function run(): { hashes: string[]; engine: RiskEngine } {
    const e = new RiskEngine(cfg());
    const hashes: string[] = [];
    for (let m = 0; m < 5; m++) {
      const t = T0 + m * MIN;
      const r = e.step(healthy(t, m === 0 ? { fills: competitiveFills(t) } : { credits: [{ id: `c${m}`, asset: "usdt:bsc", amount: usdt(1000 * m), account: "x.near", nearTx: `t${m}`, atMs: t }] }));
      hashes.push(r.routes[0]!.reportHash);
    }
    return { hashes, engine: e };
  }

  it("two watchers fed the same inputs produce identical report hashes", () => {
    expect(run().hashes).toEqual(run().hashes);
  });

  it("a watcher restored from a snapshot continues with identical hashes", () => {
    const a = new RiskEngine(cfg());
    a.step(healthy(T0, { fills: competitiveFills(T0) }));
    const b = RiskEngine.restore(cfg(), a.snapshot());
    const next = healthy(T0 + MIN);
    expect(b.step(next).routes[0]!.reportHash).toBe(a.step(next).routes[0]!.reportHash);
  });

  it("anyone can recompute a published verdict's hash", () => {
    const { engine } = run();
    const r = engine.evaluate(T0 + 4 * MIN);
    const v = r.routes[0]!;
    // evaluate() again at the same time is idempotent (no double hysteresis steps)
    expect(engine.evaluate(T0 + 4 * MIN).routes[0]!.reportHash).toBe(v.reportHash);
    const meta = { engine: ENGINE_VERSION, epoch: r.epoch, asOfMs: r.asOfMs, inputs: r.inputsDigest };
    expect(verifyVerdict(v, meta)).toBe(true);
    expect(verifyVerdict({ ...v, score: v.score - 1 }, meta)).toBe(false);
  });

  it("refuses out-of-order batches and ignores duplicate events", () => {
    const e = new RiskEngine(cfg());
    const dup = { id: "w", asset: "usdt:bsc", amount: usdt(10), account: "a.near", nearTx: "t", destChain: "bsc", atMs: T0 };
    e.ingest(healthy(T0, { withdrawals: [dup] }));
    e.ingest(healthy(T0 + MIN, { withdrawals: [dup] }));
    expect(e.state.withdrawals).toHaveLength(1);
    expect(() => e.ingest(healthy(T0))).toThrow(/before last ingested/);
  });

  it("a route touching an unconfigured asset is unknown, never green", () => {
    const e = new RiskEngine(cfg({ routes: [ROUTE, "doge:dogecoin->usdc:near"] }));
    e.ingest(healthy(T0, { fills: competitiveFills(T0) }));
    const r = e.evaluate(T0).routes[1]!;
    expect(r.status).toBe("unknown");
    expect(r.reasons).toContain("NO_DATA:doge:dogecoin");
  });
});

void E18;
