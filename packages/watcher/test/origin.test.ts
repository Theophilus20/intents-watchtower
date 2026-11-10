import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archivalNear, locateShortfall, syncHistory, treasuryAt, treasuryMoves, type NearHistory, type SupplyEvent } from "@watchtower/watcher";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2025, 0, 1);
const BTC = 100_000_000n;
const tx = (txid: string, atMs: number, vin: [string, bigint][], vout: [string, bigint][]) => ({
  txid, status: { block_time: Math.floor(atMs / 1000) },
  vin: vin.map(([a, v]) => ({ prevout: { scriptpubkey_address: a, value: Number(v) } })),
  vout: vout.map(([a, v]) => ({ scriptpubkey_address: a, value: Number(v) })),
});

/**
 * A fake NEAR with one block per minute and a list of supply events. Day 0: the treasury opens.
 * Every day a 1 BTC deposit is credited and swept 40 minutes later. Day 37 at 15:05, 2.21 BTC is
 * minted with no coins behind it: the shortfall the search must find.
 */
function world() {
  const events: SupplyEvent[] = [];
  const txs: ReturnType<typeof tx>[] = [];
  for (let d = 1; d < 60; d++) {
    const at = T0 + d * DAY + 9 * HOUR;
    events.push({ atMs: at, height: at / 60_000, delta: BTC, kind: "mint", owner: "omft.near", memo: `BRIDGED_FROM:{"txHash":"${"a".repeat(63)}${d % 10}"}`, nearTx: `DEP${d}` });
    txs.push(tx(`sweep${d}`, at + 40 * 60_000, [[`1dep${d}`, BTC]], [["1HOT", BTC]]));
  }
  const ghost = T0 + 37 * DAY + 15 * HOUR + 5 * 60_000;
  events.push({ atMs: ghost, height: ghost / 60_000, delta: 221_000_000n, kind: "mint", owner: "omft.near", memo: "", nearTx: "GHOST" });
  const supplyAt = async (h: number) => events.filter((e) => e.height <= h).reduce((t, e) => t + e.delta, 0n);
  const near: NearHistory & { calls: number } = {
    calls: 0,
    async blockAt(atMs) { this.calls++; const h = Math.ceil(atMs / 60_000); return { height: h, atMs: h * 60_000 }; },
    async supplyAt(h) { this.calls++; return supplyAt(h); },
    async creditedAt(h) { this.calls++; return supplyAt(h); },
    async eventsIn(h) { this.calls++; return events.filter((e) => e.height === h); },
  };
  return { near, txs, ghost };
}

describe("origin search", () => {
  it("finds the block and transaction where the shortfall appeared, ignoring deposits that were swept", async () => {
    const { near, txs, ghost } = world();
    const nowMs = T0 + 60 * DAY;
    const balanceNow = 59n * BTC;
    const r = await locateShortfall({
      near, hotAt: treasuryAt(treasuryMoves(txs, "1HOT"), balanceNow), hotTxs: treasuryMoves(txs, "1HOT"),
      startMs: T0, nowMs, threshold: BTC / 10n,
    });
    expect(r.overview[0]!.gap).toBe(0n);
    expect(r.overview[r.overview.length - 1]!.gap).toBe(221_000_000n);
    expect(r.steps).toHaveLength(1);
    const s = r.steps[0]!;
    expect(s.before).toBe(0n);
    expect(s.after).toBe(221_000_000n);
    expect(s.fromMs).toBeLessThanOrEqual(ghost);
    expect(s.toMs).toBeGreaterThanOrEqual(ghost - 2 * HOUR);
    expect(s.supplyChanges.map((e) => e.nearTx)).toContain("GHOST");
    // Thousands of blocks, but only a few hundred questions.
    expect(near.calls).toBeLessThan(1500);
  });

  it("reports no step when the shortfall was there from the start", async () => {
    const { near, txs } = world();
    // Start the search after the ghost mint: the shortfall never moves inside the window.
    const r = await locateShortfall({ near, hotAt: treasuryAt(treasuryMoves(txs, "1HOT"), 59n * BTC), hotTxs: [], startMs: T0 + 40 * DAY, nowMs: T0 + 60 * DAY, threshold: BTC / 10n });
    expect(r.steps).toHaveLength(0);
    expect(r.overview.every((p) => p.gap === 221_000_000n)).toBe(true);
  });
});

describe("treasury history kept between runs", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("continues where the last run stopped, and picks up what's new", async () => {
    // 80 transactions, newest first; each pays 1 BTC into the treasury.
    let all = Array.from({ length: 80 }, (_, i) => tx(`t${79 - i}`, T0 + (79 - i) * HOUR, [["1src", BTC]], [["1HOT", BTC]]));
    const api = "https://mempool.space/api/address/1HOT/txs/chain";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (!u.startsWith(api)) return new Response("no", { status: 404 });
      const after = u.slice(api.length).replace(/^\//, "");
      const i = after ? all.findIndex((t) => t.txid === after) + 1 : 0;
      return new Response(JSON.stringify(all.slice(i, i + 25)));
    }));
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const one = await syncHistory("https://mempool.space/api", "1HOT", dir, 2);
    expect(one.moves).toHaveLength(50);
    expect(one.reachedStart).toBe(false);
    all = [tx("t80", T0 + 80 * HOUR, [["1src", BTC]], [["1HOT", BTC]]), ...all]; // a new one meanwhile
    const two = await syncHistory("https://mempool.space/api", "1HOT", dir, 5);
    expect(two.moves).toHaveLength(81);
    expect(two.reachedStart).toBe(true);
    expect(two.moves[0]!.txid).toBe("t80");
    expect(two.moves.reduce((t, m) => t + m.delta, 0n)).toBe(81n * BTC); // adds up to the balance: complete
  }, 30_000);
});

describe("NEAR's archive", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("asks the next archive when one refuses, and never asks the same question twice", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(`${String(url).includes("fastnear") ? "fastnear" : "near"}:${body.method}`);
      if (String(url).includes("fastnear")) return new Response("Too Many Requests", { status: 429 });
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      if (body.method === "query") {
        if (body.params.block_id === 999) return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" }, message: "UNKNOWN_BLOCK" } }));
        return ok({ result: [...Buffer.from(JSON.stringify("8730100000"))] });
      }
      return ok({ header: { height: body.params.block_id, timestamp_nanosec: "1700000000000000000" } });
    }));
    const cacheFile = join(mkdtempSync(join(tmpdir(), "arch-")), "cache.json");
    const a = archivalNear({ contract: "btc.omft.near", issuerAccounts: [], cacheFile, intervalMs: 0 });
    expect(await a.supplyAt(500)).toBe(8_730_100_000n);
    expect(calls).toEqual(["fastnear:query", "near:query"]);
    // A block the archive doesn't have is an error, never a supply of zero.
    await expect(a.supplyAt(999)).rejects.toThrow();
    a.flush();
    calls.length = 0;
    const b = archivalNear({ contract: "btc.omft.near", issuerAccounts: [], cacheFile, intervalMs: 0 });
    expect(await b.supplyAt(500)).toBe(8_730_100_000n);
    expect(calls).toEqual([]); // answered from the saved file
  });
});

describe("miner fee tally", () => {
  it("separates fees the treasury paid from fees on payments into it", async () => {
    const { tallyFees } = await import("../src/origin.ts");
    const T = "treasury";
    const tx = (txid: string, ins: [string, number][], outs: [string, number][], time = 1_700_000_000) => ({ txid, status: { block_time: time }, vin: ins.map(([a, v]) => ({ prevout: { scriptpubkey_address: a, value: v } })), vout: outs.map(([a, v]) => ({ scriptpubkey_address: a, value: v })) });
    const t = tallyFees({ address: T, done: false, spendFees: "0", spendTxs: 0, inFees: "0", inTxs: 0 }, [
      tx("a", [[T, 1000]], [["user", 700], [T, 250]]), // payout: 50 fee
      tx("b", [["deposit", 500]], [[T, 480]]), // sweep: 20 fee
      tx("c", [[T, 100]], [["user", 90]], 0), // unconfirmed: ignored
      { txid: "d", status: { block_time: 1_600_000_000 }, vin: [{}], vout: [{ scriptpubkey_address: T, value: 5 }] }, // no inputs known: ignored
    ]);
    expect(t.spendFees).toBe("50");
    expect(t.spendTxs).toBe(1);
    expect(t.inFees).toBe("20");
    expect(t.inTxs).toBe(1);
    expect(t.oldestMs).toBe(1_700_000_000_000);
  });
});
