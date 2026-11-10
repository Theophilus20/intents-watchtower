import { describe, expect, it } from "vitest";
import { verifyVerdict, ENGINE_VERSION } from "@watchtower/engine";
import { getScenario, runScenario } from "@watchtower/replay";
import { openPglite } from "@watchtower/store";

describe("Postgres store (PGlite, real SQL)", () => {
  it("migrates, stores verdicts, and returns them verifiable", async () => {
    const store = await openPglite();
    const r = runScenario(getScenario("usdt-bsc-depeg"));
    await store.saveReport(r.finalReport);
    const route = "usdt:bsc->usdc:near";
    const hist = await store.routeHistory(route, 0);
    expect(hist).toHaveLength(1);
    const stored = (await store.storedReport(route, r.finalReport.epoch))!;
    const { engine, inputs, asOfMs, ...verdict } = stored as Record<string, unknown>;
    expect(engine).toBe(ENGINE_VERSION);
    expect(verifyVerdict(JSON.parse(JSON.stringify(verdict)), { engine: ENGINE_VERSION, epoch: r.finalReport.epoch, asOfMs: asOfMs as number, inputs: inputs as string })).toBe(true);

    const id = await store.saveAlert({ route, severity: "red", fromStatus: "green", reasons: ["ASSET_DEPEG:usdt:bsc"], explanation: "🔴 test", sentAtMs: 1 });
    expect(id).toBeGreaterThan(0);
    expect((await store.recentAlerts())[0]).toMatchObject({ route, severity: "red", reasons: ["ASSET_DEPEG:usdt:bsc"] });

    await store.saveState("w1", "{}", 5, "0".repeat(64));
    await store.saveState("w1", '{"v":2}', 6, "1".repeat(64));
    expect(await store.loadState("w1")).toBe('{"v":2}');
  }, 60_000);
});
