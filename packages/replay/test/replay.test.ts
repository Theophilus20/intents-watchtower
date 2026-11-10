import { describe, expect, it } from "vitest";
import { STATUS_RANK } from "@watchtower/core";
import { SCENARIOS, World, getScenario, runScenario } from "@watchtower/replay";

describe("simulated world", () => {
  it("is deterministic for a seed", () => {
    const a = new World({ seed: "x", startMs: Date.UTC(2026, 0, 1) });
    const b = new World({ seed: "x", startMs: Date.UTC(2026, 0, 1) });
    for (let i = 0; i < 5; i++) {
      a.tick();
      b.tick();
    }
    expect(a.ledger.get("btc:bitcoin")).toEqual(b.ledger.get("btc:bitcoin"));
  });

  it("keeps every bridged asset fully backed during normal traffic", () => {
    const w = new World({ seed: "invariants", startMs: Date.UTC(2026, 0, 1) });
    for (let i = 0; i < 120; i++) w.tick();
    for (const a of w.assets.filter((x) => x.bridge !== "native")) expect(w.trueBackingPpm(a.key)).toBeGreaterThanOrEqual(1_000_000);
  });
});

describe.each(SCENARIOS.map((s) => [s.id, s] as const))("scenario %s", (_id, scenario) => {
  const r = runScenario(scenario);

  it("is calm before the incident (no red anywhere, focus routes not alerting)", () => {
    for (const f of r.frames.filter((x) => x.t < 0)) {
      expect(f.routes.filter((x) => x.status === "red")).toEqual([]);
      for (const route of scenario.focusRoutes) expect(f.routes.find((x) => x.route === route)!.status).not.toBe("red");
    }
  });

  if (scenario.expect.focusRed) it("turns the focus routes red", () => expect(r.summary.firstRedT).not.toBeNull());
  if (scenario.expect.focusMaxStatus) {
    it(`never takes focus routes beyond ${scenario.expect.focusMaxStatus}`, () => {
      expect(STATUS_RANK[r.summary.focusWorst]).toBeLessThanOrEqual(STATUS_RANK[scenario.expect.focusMaxStatus!]);
      expect(r.summary.firstAlertT).not.toBeNull();
    });
  }
  if (scenario.expect.noCollateralRed) it("never turns an unrelated route red (precision)", () => expect(r.summary.collateralRedMinutes).toBe(0));
  if (scenario.expect.recoversByEnd) it("recovers to green after the incident", () => expect(r.summary.recovered).toBe(true));

  it("produces a hash for every route in every frame", () => {
    for (const f of r.frames) for (const x of f.routes) expect(x.reportHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("1 Oct 2026 ghost-credit replay", () => {
  const r = runScenario(getScenario("oct-2026-ghost-credit"));

  it("alerts in the same minute as the first ghost credit and is red within 5 minutes", () => {
    expect(r.summary.attack!.firstGhostT).toBe(0);
    expect(r.summary.firstAlertT).toBe(0);
    expect(r.summary.firstRedT).toBeLessThanOrEqual(5);
  });

  it("models ~$3.8M of ghost credits and reports how much moved after the alarm", () => {
    const ghost = Number(BigInt(r.summary.attack!.ghostCreditedUsdCents) / 100n);
    expect(ghost).toBeGreaterThan(3_700_000);
    expect(ghost).toBeLessThan(3_900_000);
    expect(r.summary.attack!.shareAfterRedPpm).toBeGreaterThan(900_000);
  });

  it("names the October pattern in its reasons", () => {
    const red = r.frames.find((f) => f.t === r.summary.firstRedT)!;
    const route = red.routes.find((x) => x.route === "usdt:bsc->usdc:near")!;
    expect(route.reasons[0]).toBe("GHOST_CREDIT_WITHDRAWN:usdt:bsc");
  });

  it("is reproducible: same scenario, same hashes", () => {
    const again = runScenario(getScenario("oct-2026-ghost-credit"));
    expect(again.frames.at(-1)!.routes.map((x) => x.reportHash)).toEqual(r.frames.at(-1)!.routes.map((x) => x.reportHash));
  });
});
