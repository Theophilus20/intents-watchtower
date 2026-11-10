import { describe, expect, it, vi } from "vitest";
import { ContractMirror, generateWatcherKey, signAttestation, type VerdictPayload } from "@watchtower/core";
import { RouteUnsafeError, RpcSource, Watchtower, withWatchtower } from "@watchtower/sdk";

const EPOCH = 29_843_520;
const NOW = EPOCH * 60_000 + 10_000;

function mirrorWith(verdicts: [string, VerdictPayload["status"], number][]) {
  const m = new ContractMirror("watchtower.near", 2, 1);
  m.nowMs = NOW;
  const keys = [1, 2].map((i) => ({ id: `w${i}.near`, k: generateWatcherKey(new Uint8Array(32).fill(i)) }));
  for (const { id, k } of keys) m.addWatcher(id, k.publicKey);
  for (const [route, status, score] of verdicts) {
    const p: VerdictPayload = { route_id: route, epoch: EPOCH, status, score, capacity_usd: status === "red" || status === "unknown" ? 0 : 50_000, reasons: status === "red" ? ["GHOST_CREDIT:usdt:bsc"] : [], report_hash: "ab".repeat(32) };
    m.submitReport(p, keys.map(({ id, k }) => signAttestation("watchtower.near", p, id, k.secretKey)));
  }
  return new Watchtower({ source: { view: async (method, args) => m.view(method, args) as never }, cacheMs: 0 });
}

describe("Watchtower client", () => {
  it("answers is_safe and explains why not", async () => {
    const wt = mirrorWith([["btc:bitcoin->usdc:near", "green", 100], ["usdt:bsc->usdc:near", "red", 12]]);
    expect(await wt.isSafe("BTC:Bitcoin -> USDC:NEAR")).toBe(true);
    const c = await wt.check("usdt:bsc->usdc:near");
    expect(c).toMatchObject({ safe: false, verdict: "status", status: "red", reasons: ["GHOST_CREDIT:usdt:bsc"] });
    await expect(wt.assertSafe("usdt:bsc->usdc:near")).rejects.toBeInstanceOf(RouteUnsafeError);
    expect((await wt.check("eth:ethereum->usdc:near")).verdict).toBe("no_data");
  });

  it("picks the safest route", async () => {
    const wt = mirrorWith([["a:x->b:y", "green", 90], ["c:x->b:y", "green", 100], ["d:x->b:y", "red", 5]]);
    expect(await wt.safestRoute(["a:x->b:y", "c:x->b:y", "d:x->b:y"])).toBe("c:x->b:y");
  });

  it("fails closed when the oracle is unreachable", async () => {
    const wt = new Watchtower({ source: { view: async () => { throw new Error("ECONNRESET"); } } });
    const c = await wt.check("btc:bitcoin->usdc:near");
    expect(c.safe).toBe(false);
    expect(c.verdict).toBe("error");
    expect(await new Watchtower({ failOpen: true, source: { view: async () => { throw new Error("down"); } } }).isSafe("btc:bitcoin->usdc:near")).toBe(true);
  });

  it("speaks NEAR JSON-RPC call_function", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.params).toMatchObject({ request_type: "call_function", account_id: "watchtower.testnet", method_name: "check_route" });
      expect(JSON.parse(atob(body.params.args_base64))).toMatchObject({ route_id: "btc:bitcoin->usdc:near", allow_amber: true });
      const result = [...new TextEncoder().encode(JSON.stringify({ route_id: "btc:bitcoin->usdc:near", safe: true, verdict: "ok", status: "amber", score: 70, reasons: [], age_sec: 12, report_hash: "x" }))];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "watchtower", result: { result, logs: [] } }));
    });
    const wt = new Watchtower({ network: "testnet", fetch: fetchMock as unknown as typeof fetch });
    expect(await wt.isSafe("btc:bitcoin->usdc:near", { allowAmber: true })).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    // cached
    await wt.isSafe("btc:bitcoin->usdc:near", { allowAmber: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces contract errors from RPC", async () => {
    const src = new RpcSource("http://x", "w.near", (async () => new Response(JSON.stringify({ result: { error: "MethodNotFound" } }))) as unknown as typeof fetch);
    await expect(src.view("nope", {})).rejects.toThrow(/MethodNotFound/);
  });
});

describe("withWatchtower", () => {
  const agent = { calls: [] as string[], async swap(req: { route: string }) { this.calls.push(req.route); return req.route; }, async quote(x: number) { return x * 2; } };

  it("lets safe swaps through, reroutes unsafe ones, blocks when no alternative", async () => {
    const wt = mirrorWith([["usdt:bsc->usdc:near", "red", 10], ["usdc:ethereum->usdc:near", "green", 100]]);
    const decisions: string[] = [];
    const guarded = withWatchtower(agent, {
      client: wt,
      alternatives: () => ["usdc:ethereum->usdc:near"],
      withRoute: (args, route) => [{ ...(args[0] as object), route }],
      onDecision: (d) => decisions.push(`${d.requested}=>${d.used}`),
    });
    expect(await guarded.swap({ route: "usdt:bsc->usdc:near" })).toBe("usdc:ethereum->usdc:near");
    expect(decisions).toEqual(["usdt:bsc->usdc:near=>usdc:ethereum->usdc:near"]);
    expect(await guarded.quote(2)).toBe(4); // unguarded methods untouched

    const strict = withWatchtower(agent, { client: wt });
    await expect(strict.swap({ route: "usdt:bsc->usdc:near" })).rejects.toThrow(/not safe right now/);
  });
});
