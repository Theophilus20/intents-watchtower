import { describe, expect, it } from "vitest";
import { getScenario, runScenario } from "@watchtower/replay";
import { aiExplain, explain, extractFacts, LANGS, templateExplain, validateAiText, type Lang } from "@watchtower/explainer";

const r = runScenario(getScenario("oct-2026-ghost-credit"));
const redVerdict = r.transitions.find((t) => t.to === "red" && t.route === "usdt:bsc->usdc:near")!.verdict;

describe("explainer", () => {
  it("extracts figures from the verdict, not from thin air", () => {
    const f = extractFacts(redVerdict);
    expect(f.status).toBe("red");
    expect(f.codes[0]).toBe("GHOST_CREDIT_WITHDRAWN");
    expect(f.figures.exitedUsd).toMatch(/^\$\d/);
    expect(f.routeLabel).toBe("USDT (BNB Chain) → USDC (NEAR)");
  });

  it.each(Object.keys(LANGS) as Lang[])("writes a %s sentence that starts with the status", (lang) => {
    const t = templateExplain(extractFacts(redVerdict), lang);
    expect(t.startsWith("🔴")).toBe(true);
    expect(t.length).toBeLessThan(300);
  });

  it("writes French and Spanish alerts", () => {
    expect(templateExplain(extractFacts(redVerdict), "fr")).toMatch(/Évitez cette route/);
    expect(templateExplain(extractFacts(redVerdict), "es")).toMatch(/Evita esta ruta/);
  });

  it("rejects AI text that invents numbers or flips the status", () => {
    const f = extractFacts(redVerdict);
    expect(validateAiText(`🔴 BTC route paused: 999 BTC missing.`, f)).toBeNull();
    expect(validateAiText(`🟢 All good.`, f)).toBeNull();
    expect(validateAiText(`🔴 Unbacked credits are being withdrawn; avoid this route.`, f)).not.toBeNull();
  });

  it("falls back to the template when NEAR AI misbehaves or is down", async () => {
    const f = extractFacts(redVerdict);
    const liar = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "🔴 $50M stolen by North Korea" } }] }))) as unknown as typeof fetch;
    expect((await aiExplain(f, "en", { apiKey: "k", fetch: liar })).source).toBe("template");
    const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect((await aiExplain(f, "en", { apiKey: "k", fetch: down })).source).toBe("template");
    const good = (async (_u: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).model).toBeTruthy();
      return new Response(JSON.stringify({ choices: [{ message: { content: "🔴 Money credited without a deposit is leaving this route. Avoid it for now." } }] }));
    }) as unknown as typeof fetch;
    expect((await aiExplain(f, "en", { apiKey: "k", fetch: good })).source).toBe("near-ai");
  });

  it("explains green plainly", async () => {
    const green = r.frames[0]!.routes.find((x) => x.status === "green")!;
    const e = await explain({ route: green.route, status: "green", reasons: [], components: [] });
    expect(e.text).toMatch(/^🟢 .* healthy\. All checks passing\.$/);
  });
});

describe("partly verified", () => {
  const v = {
    route: "btc:bitcoin->usdc:near",
    status: "unknown" as const,
    reasons: ["BACKING_PARTIAL:btc:bitcoin", "GHOST_UNCHECKED:btc:bitcoin"],
    components: [{ check: "backing" as const, subject: "btc:bitcoin", status: "unknown" as const, penalty: 20, reasons: ["BACKING_PARTIAL:btc:bitcoin"], evidence: [], metrics: { backing_ppm: 974_665, deficit: "221210000", baseline_gap: "221210000", partial_since_ms: Date.UTC(2026, 4, 6, 3, 21) } }],
  };
  it("says how much is missing and since when, in every language", () => {
    const facts = extractFacts(v);
    expect(facts.figures).toMatchObject({ backingPct: "97.47%", gapAmount: "2.2121 BTC", sinceDate: "2026-05-06" });
    expect(templateExplain(facts, "en")).toBe("⚪ BTC (Bitcoin) → USDC (NEAR) unverified. The bridge's treasury holds only 97.47% of what users are owed (2.2121 BTC short, already short on 2026-05-06). We can't vouch for it right now, so treat it as unsafe.");
    for (const lang of Object.keys(LANGS) as Lang[]) {
      const t = templateExplain(facts, lang);
      expect(t, lang).toContain("97.47%");
      expect(t, lang).toContain("2.2121 BTC");
      expect(t, lang).toContain("2026-05-06");
    }
  });
});
