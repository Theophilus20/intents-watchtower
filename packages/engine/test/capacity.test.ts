import { describe, expect, it } from "vitest";
import type { ObservationBatch, RouteId } from "@watchtower/core";
import { ContractMirror, DEFAULT_ASSETS, DEFAULT_CHAINS, generateWatcherKey, signAttestation } from "@watchtower/core";
import { DEFAULT_CAPACITY_USD, RiskEngine, defaultConfig, preflight, roundDown, type RouteState } from "@watchtower/engine";
import { SCENARIOS, runScenario } from "@watchtower/replay";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const IN: RouteId = "usdt:bsc->usdc:near";
const OUT: RouteId = "usdc:near->usdt:bsc";
const usdt = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

function engine(routes: RouteId[]) {
  return new RiskEngine(defaultConfig({
    assets: DEFAULT_ASSETS.filter((a) => a.key === "usdt:bsc" || a.key === "usdc:near"),
    chains: DEFAULT_CHAINS.filter((c) => c.id === "bsc" || c.id === "near"),
    routes,
  }));
}

function fills(route: RouteId, t: number, usd: number) {
  const solvers = ["a.near", "b.near", "c.near", "d.near", "e.near", "f.near", "g.near", "h.near"];
  return Array.from({ length: 40 }, (_, i) => ({ id: `${route}-f${i}`, route, solver: solvers[i % 8]!, usdCents: BigInt(usd * 100), atMs: t - i * MIN }));
}

function healthy(t: number, over: Partial<ObservationBatch> = {}, custody = 10_050_000): ObservationBatch {
  return {
    asOfMs: t,
    supply: [{ asset: "usdt:bsc", credited: usdt(10_000_000), pendingWithdrawals: 0n, atMs: t }],
    custody: [{ asset: "usdt:bsc", balance: usdt(custody), atMs: t }],
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

describe("safe size", () => {
  it("is the depth solvers have actually shown: the three largest recent fills", () => {
    const e = engine([IN]);
    e.ingest(healthy(T0, { fills: fills(IN, T0, 1_200) }));
    const v = e.evaluate(T0).routes[0]!;
    expect(v.status).toBe("green");
    expect(v.capacityBasis).toBe("solvers");
    expect(v.capacityUsd).toBe(3_600);
  });

  it("is capped at half of the hot wallets that pay a bridged destination", () => {
    const e = engine([OUT]);
    e.ingest(healthy(T0, {
      fills: fills(OUT, T0, 40_000),
      hotWallets: [{ asset: "usdt:bsc", address: "0xhot", balance: usdt(130_000), atMs: T0 }],
    }));
    const v = e.evaluate(T0).routes[0]!;
    expect(v.status).toBe("green");
    expect(v.capacityBasis).toBe("payout");
    expect(v.capacityUsd).toBe(65_000);
  });

  it("falls back to a conservative default when nothing has been observed", () => {
    const e = engine([IN]);
    e.ingest(healthy(T0));
    const v = e.evaluate(T0).routes[0]!;
    if (v.status === "green") {
      expect(v.capacityBasis).toBe("default");
      expect(v.capacityUsd).toBe(DEFAULT_CAPACITY_USD);
    } else {
      expect(v.capacityUsd).toBeLessThanOrEqual(DEFAULT_CAPACITY_USD / 2);
    }
  });

  it("halves on amber and is zero on red", () => {
    const amber = engine([IN]);
    amber.ingest(healthy(T0, { fills: fills(IN, T0, 1_200) }, 9_970_000));
    const a = amber.evaluate(T0).routes[0]!;
    expect(a.status).toBe("amber");
    expect(a.capacityUsd).toBe(1_800);

    const red = engine([IN]);
    red.ingest(healthy(T0, { fills: fills(IN, T0, 1_200) }, 9_000_000));
    const r = red.evaluate(T0).routes[0]!;
    expect(r.status).toBe("red");
    expect(r.capacityUsd).toBe(0);
    expect(r.capacityBasis).toBe("blocked");
  });

  it("is part of the signed report hash", () => {
    const a = engine([IN]);
    const b = engine([IN]);
    a.ingest(healthy(T0, { fills: fills(IN, T0, 1_200) }));
    b.ingest(healthy(T0, { fills: fills(IN, T0, 2_400) }));
    const va = a.evaluate(T0).routes[0]!;
    const vb = b.evaluate(T0).routes[0]!;
    expect(va.status).toBe(vb.status);
    expect(va.capacityUsd).not.toBe(vb.capacityUsd);
    expect(va.reportHash).not.toBe(vb.reportHash);
  });

  it("rounds down to stable, readable steps", () => {
    expect(roundDown(0)).toBe(0);
    expect(roundDown(-5)).toBe(0);
    expect(roundDown(9_999)).toBe(9_900);
    expect(roundDown(10_000)).toBe(10_000);
    expect(roundDown(65_432)).toBe(65_000);
    expect(roundDown(1_234_567)).toBe(1_230_000);
  });

  it("drops to zero on every affected route the minute the October replay goes red", () => {
    const run = runScenario(SCENARIOS.find((s) => s.id === "oct-2026-ghost-credit")!, {});
    const before = run.frames.find((f) => f.t === -10)!;
    const after = run.frames.find((f) => f.t === 30)!;
    for (const route of ["usdt:bsc->usdc:near", "near:near->usdt:bsc"]) {
      expect(before.routes.find((r) => r.route === route)!.capacityUsd).toBeGreaterThan(50_000);
      const now = after.routes.find((r) => r.route === route)!;
      expect(now.status).toBe("red");
      expect(now.capacityUsd).toBe(0);
    }
    // Unrelated corridors keep their size.
    expect(after.routes.find((r) => r.route === "eth:ethereum->usdc:near")!.capacityUsd).toBeGreaterThan(50_000);
  });
});

describe("swap pre-flight", () => {
  const routes: RouteState[] = [
    { route: "usdt:bsc->usdc:near", status: "red", score: 4, capacityUsd: 0, reasons: ["GHOST_CREDIT:usdt:bsc"] },
    { route: "usdt:ethereum->usdc:near", status: "green", score: 93, capacityUsd: 80_000, reasons: [] },
    { route: "eth:ethereum->usdc:near", status: "green", score: 95, capacityUsd: 120_000, reasons: [] },
    { route: "btc:bitcoin->usdc:near", status: "green", score: 91, capacityUsd: 40_000, reasons: [] },
    { route: "ltc:litecoin->usdc:near", status: "amber", score: 61, capacityUsd: 20_000, reasons: ["CHAIN_HALTED:litecoin"] },
  ];

  it("says go when the route is healthy and the amount fits", () => {
    expect(preflight("btc:bitcoin->usdc:near", 25_000, routes).decision).toBe("go");
  });

  it("reroutes a blocked swap to the healthiest route into the same token", () => {
    const p = preflight("usdt:bsc->usdc:near", 50_000, routes);
    expect(p.decision).toBe("reroute");
    expect(p.alternative?.route).toBe("eth:ethereum->usdc:near");
  });

  it("prefers keeping the token you hold over funding from another one", () => {
    const withSameSource: RouteState[] = [
      ...routes.filter((r) => r.route !== "btc:bitcoin->usdc:near"),
      { route: "btc:bitcoin->usdc:ethereum", status: "green", score: 88, capacityUsd: 60_000, reasons: [] },
      { route: "btc:bitcoin->usdc:near", status: "red", score: 9, capacityUsd: 0, reasons: ["CHAIN_HALTED:bitcoin"] },
    ];
    const p = preflight("btc:bitcoin->usdc:near", 30_000, withSameSource);
    expect(p.decision).toBe("reroute");
    expect(p.alternative?.route).toBe("btc:bitcoin->usdc:ethereum");
    expect(p.alternativeKind).toBe("same_source");
  });

  it("only offers alternatives big enough for the amount", () => {
    const p = preflight("usdt:bsc->usdc:near", 100_000, routes);
    expect(p.alternative?.route).toBe("eth:ethereum->usdc:near");
    expect(preflight("usdt:bsc->usdc:near", 500_000, routes).decision).toBe("wait");
  });

  it("asks to split when the route is fine but too small and nothing bigger exists", () => {
    const solo: RouteState[] = [{ route: "btc:bitcoin->usdc:near", status: "green", score: 91, capacityUsd: 40_000, reasons: [] }];
    const p = preflight("btc:bitcoin->usdc:near", 100_000, solo);
    expect(p.decision).toBe("reduce");
    expect(p.splitInto).toBe(3);
  });

  it("waits when it has never seen the route", () => {
    expect(preflight("doge:dogecoin->usdc:near", 10, routes).decision).toBe("wait");
  });

  it("treats amber as usable only when the caller allows it", () => {
    expect(preflight("ltc:litecoin->usdc:near", 5_000, routes).decision).toBe("go");
    expect(preflight("ltc:litecoin->usdc:near", 5_000, routes, { allowAmber: false }).decision).toBe("reroute");
  });
});

describe("check_intent on the contract model", () => {
  it("allows up to the signed safe size and refuses above it", () => {
    const m = new ContractMirror("watchtower.near", 1);
    const k = generateWatcherKey(new Uint8Array(32).fill(7));
    m.addWatcher("w1.near", k.publicKey);
    const epoch = Math.floor(T0 / MIN);
    m.nowMs = T0;
    const payload = { route_id: IN, epoch, status: "green" as const, score: 92, capacity_usd: 50_000, reasons: [], report_hash: "a".repeat(64) };
    m.submitReport(payload, [signAttestation("watchtower.near", payload, "w1.near", k.secretKey)]);
    expect(m.checkIntent(IN, 50_000).allowed).toBe(true);
    const big = m.checkIntent(IN, 50_001);
    expect(big.safe).toBe(true);
    expect(big.allowed).toBe(false);
    expect(big.verdict).toBe("over_capacity");
    expect(m.view("check_intent", { route_id: IN, amount_usd: 10 })).toMatchObject({ allowed: true });
  });

  it("rejects a relayer that inflates the safe size after signing", () => {
    const m = new ContractMirror("watchtower.near", 1);
    const k = generateWatcherKey(new Uint8Array(32).fill(8));
    m.addWatcher("w1.near", k.publicKey);
    m.nowMs = T0;
    const signed = { route_id: IN, epoch: Math.floor(T0 / MIN), status: "green" as const, score: 92, capacity_usd: 50_000, reasons: [], report_hash: "b".repeat(64) };
    const att = signAttestation("watchtower.near", signed, "w1.near", k.secretKey);
    expect(() => m.submitReport({ ...signed, capacity_usd: 5_000_000 }, [att])).toThrow(/invalid signature/);
  });
});
