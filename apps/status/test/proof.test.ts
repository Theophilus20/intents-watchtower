import { afterEach, describe, expect, it, vi } from "vitest";
import { readBacking, routeBacking, routeBackingError } from "../src/proof.ts";

afterEach(() => vi.unstubAllGlobals());

describe("the page's own backing check", () => {
  it("reads supply on NEAR and the treasury on Bitcoin, and works out the backing and shortfall", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("fastnear")) {
        const body = JSON.parse(String(init?.body));
        const ok = (v: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify(v))] } }));
        const m = body.params.method_name;
        if (m === "ft_total_supply") return ok("8730100000");
        if (m === "mt_balance_of") return ok("0");
        const who = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()).account_id;
        return ok(who === "btc.omft.near" ? "70000" : "0");
      }
      if (String(url).includes("mempool.space/api/address/1C6XJ")) return new Response(JSON.stringify({ chain_stats: { funded_txo_sum: 8_508_810_000, spent_txo_sum: 0 }, mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 } }));
      return new Response("no", { status: 404 });
    }));
    const by = await readBacking({
      nearRpc: "https://free.rpc.fastnear.com",
      chains: { bitcoin: { kind: "esplora", url: "https://mempool.space/api" } },
      assets: { "btc:bitcoin": { chain: "bitcoin", decimals: 8, custody: ["1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra"], nearContract: "btc.omft.near", issuerAccounts: ["btc.omft.near", "omft.near"], partial: true } },
    });
    const btc = by.get("btc:bitcoin")!;
    expect(btc.owed).toBe(8_730_030_000n);
    expect(btc.held).toBe(8_508_810_000n);
    expect(btc.short).toBe(221_220_000n);
    expect(btc.ppm).toBe(974_659);
    // A route takes its bridged asset's backing; NEAR-native USDC needs none.
    expect(routeBacking("btc:bitcoin->usdc:near", by)).toBe(974_659);
    expect(routeBacking("near:near->usdc:near", by)).toBeNull();
    // If one side can't be read, the route's backing is unknown rather than the other side's.
    by.set("sol:solana", { asset: "sol:solana", ppm: null, decimals: 9, error: "HTTP 403" });
    expect(routeBacking("btc:bitcoin->sol:solana", by)).toBeNull();
  });

  it("reports an unreadable asset instead of guessing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const by = await readBacking({ nearRpc: "https://free.rpc.fastnear.com", chains: { bitcoin: { kind: "esplora", url: "https://mempool.space/api" } }, assets: { "btc:bitcoin": { chain: "bitcoin", decimals: 8, custody: ["1C6X"], nearContract: "btc.omft.near" } } });
    expect(by.get("btc:bitcoin")!.ppm).toBeNull();
    expect(by.get("btc:bitcoin")!.error).toBeTruthy();
  });
});

describe("when a chain's server refuses the browser", () => {
  it("asks the fallback server, and says why if every server refuses", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      seen.push(new URL(String(url)).host);
      if (String(url).includes("fastnear")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify("1000000000"))] } }));
      if (String(url).includes("api.mainnet-beta.solana.com")) return new Response("Forbidden", { status: 403 });
      if (String(url).includes("solana-rpc.publicnode.com")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { value: 1_020_000_000 } }));
      return new Response("no", { status: 404 });
    }));
    const by = await readBacking({ nearRpc: "https://free.rpc.fastnear.com", chains: { solana: { kind: "solana", url: "https://api.mainnet-beta.solana.com" } }, assets: { "sol:solana": { chain: "solana", decimals: 9, custody: ["Hot1"], nearContract: "sol.omft.near" } } });
    expect(by.get("sol:solana")!.ppm).toBe(1_020_000);
    expect(seen).toContain("solana-rpc.publicnode.com");
    // Every server refusing: the n/a says why.
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(url).includes("fastnear")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify("1000000000"))] } }));
      return new Response("Forbidden", { status: 403 });
    }));
    const none = await readBacking({ nearRpc: "https://free.rpc.fastnear.com", chains: { solana: { kind: "solana", url: "https://api.mainnet-beta.solana.com" } }, assets: { "sol:solana": { chain: "solana", decimals: 9, custody: ["Hot1"], nearContract: "sol.omft.near" } } });
    expect(routeBackingError("eth:ethereum->sol:solana", none)).toMatch(/^SOL: .*403/);
  });
});
