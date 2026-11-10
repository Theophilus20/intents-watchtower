import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCustody, findCustody, gapProfile, historyEvents, homeToken, reconcilePayouts, type AssetFinding } from "@watchtower/watcher";

const H = (c: string) => c.repeat(64);
const PAYOUT = H("b");
const DEPOSIT = H("a");

/** A small Bitcoin world: one withdrawal paid by a hot wallet, one deposit swept to a cold wallet that refills it. */
function world(coldBtc: number, heldByBridge = 0) {
  const esplora: Record<string, unknown> = {
    [`/tx/${PAYOUT}`]: { txid: PAYOUT, vin: [{ prevout: { scriptpubkey_address: "bc1hot", value: 30_000_000 } }], vout: [{ scriptpubkey_address: "bc1user", value: 29_990_000 }] },
    [`/tx/${DEPOSIT}`]: { txid: DEPOSIT, vin: [{ prevout: { scriptpubkey_address: "bc1someone", value: 60_000_000 } }], vout: [{ scriptpubkey_address: "bc1dep", value: 50_000_000 }, { scriptpubkey_address: "bc1change", value: 9_990_000 }] },
    "/address/bc1dep/txs": [{ txid: "s", vin: [{ prevout: { scriptpubkey_address: "bc1dep", value: 50_000_000 } }], vout: [{ scriptpubkey_address: "bc1cold", value: 49_990_000 }] }],
    "/address/bc1hot/txs/chain": [{ txid: "r", vin: [{ prevout: { scriptpubkey_address: "bc1cold", value: 200_000_000 } }], vout: [{ scriptpubkey_address: "bc1hot", value: 100_000_000 }] }],
    "/address/bc1hot": { chain_stats: { funded_txo_sum: 200_000_000, spent_txo_sum: 0 } },
    "/address/bc1dep": { chain_stats: { funded_txo_sum: 50_000_000, spent_txo_sum: 50_000_000 } },
    "/address/bc1cold": { chain_stats: { funded_txo_sum: coldBtc * 1e8, spent_txo_sum: 0 } },
    "/address/bc1waiting": { chain_stats: { funded_txo_sum: 30_000_000, spent_txo_sum: 0 } },
  };
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (result: unknown) => new Response(JSON.stringify(body ? { jsonrpc: "2.0", id: body.id, result } : result));
    if (body?.method === "query" && body.params.account_id === "btc.omft.near") {
      const value = body.params.method_name === "ft_total_supply" ? "1000000000" : String(heldByBridge * 1e8); // 10 BTC credited
      return ok({ result: [...Buffer.from(JSON.stringify(value))] });
    }
    if (body?.method === "withdrawal_status") return ok({ status: "COMPLETED", data: { transfer_tx_hash: PAYOUT } });
    if (body?.method === "supported_tokens") return ok({ tokens: [{ near_token_id: "nep141:btc.omft.near", defuse_asset_identifier: "btc:mainnet:native", decimals: 8, asset_name: "BTC", min_deposit_amount: "0", min_withdrawal_amount: "0", withdrawal_fee: "0" }] });
    if (body?.method === "recent_deposits") return ok({ deposits: body.params[0].account_id === "bob.near" && body.params[0].chain === "btc:mainnet" ? [{ chain: "btc:mainnet", address: "bc1waiting", status: "COMPLETED", account_id: "bob.near", amount: 30_000_000, decimals: 8, defuse_asset_identifier: "btc:mainnet:native" }] : [] });
    if (String(url).startsWith("https://mempool.space/api")) {
      const v = esplora[String(url).slice("https://mempool.space/api".length)];
      if (v !== undefined) return ok(v);
    }
    return new Response("not here", { status: 404 });
  });
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "custody-"));
  writeFileSync(join(dir, "bridge-events-1.jsonl"), [
    { kind: "withdrawal", asset: "btc:bitcoin", amount: "30000000", account: "alice.near", nearTx: "NEAR_TX_1", atMs: 2 },
    { kind: "deposit", asset: "btc:bitcoin", amount: "50000000", account: "bob.near", nearTx: "NEAR_TX_2", atMs: 1, sourceTxRef: DEPOSIT },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const config = join(dir, "watchtower.config.json");
  writeFileSync(config, JSON.stringify({ contractId: "watchtower.you.testnet", live: { assets: { "btc:bitcoin": { custody: ["<bc1… custody address 1>"], nearContract: "btc.omft.near" } } } }));
  return { dir, config };
}

afterEach(() => vi.unstubAllGlobals());

describe("custody finder", () => {
  it("traces a bridge's hot, deposit and cold wallets from its own transactions", async () => {
    vi.stubGlobal("fetch", world(8.5));
    const { dir, config } = setup();
    const found = await findCustody({ dir, configPath: config, history: false });
    const btc = found.find((f) => f.asset === "btc:bitcoin")!;
    expect(btc.addresses.map((x) => [x.role, x.address])).toEqual([
      ["hot wallet", "bc1hot"],
      ["deposit address", "bc1dep"],
      ["treasury", "bc1cold"],
      ["treasury", "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra"], // NEAR Intents' published treasury, always checked
      ["deposit address", "bc1waiting"],
    ]);
    // The user's change output is never mistaken for the bridge's.
    expect(btc.addresses.some((x) => x.address === "bc1change")).toBe(false);
    expect(btc.coveragePpm).toBe(1_050_000);
    expect(btc.verdict).toBe("complete");
    // A user's deposit address the bridge hasn't swept yet is evidence, never custody.
    expect(btc.unswept).toBe("30000000");
    expect(btc.coverageWithUnsweptPpm).toBe(1_080_000);

    applyCustody(found, config);
    const cfg = JSON.parse(readFileSync(config, "utf8"));
    expect(cfg.live.assets["btc:bitcoin"].hotWallets).toEqual(["bc1hot"]);
    expect(cfg.live.assets["btc:bitcoin"].custody).toEqual(["bc1hot", "bc1cold"]);
  });

  it("doesn't count tokens the bridge holds itself as owed to users", async () => {
    // 10 BTC credited, 0.6 of them sitting in the bridge's own account: 9.4 owed, and 9.4 found.
    vi.stubGlobal("fetch", world(7.4, 0.6));
    const { dir, config } = setup();
    const found = await findCustody({ dir, configPath: config, history: false });
    const btc = found.find((f) => f.asset === "btc:bitcoin")!;
    expect(btc.bridgeHeld).toBe("60000000");
    expect(btc.coveragePpm).toBe(1_000_000);
    expect(btc.verdict).toBe("complete");
    applyCustody(found, config);
    // The watchers then subtract the same balance, so they see what the finder saw.
    expect(JSON.parse(readFileSync(config, "utf8")).live.assets["btc:bitcoin"].issuerAccounts).toEqual(["btc.omft.near"]);
  });

  it("never proposes custody that would hold less than the supply", async () => {
    vi.stubGlobal("fetch", world(5));
    const { dir, config } = setup();
    const found = await findCustody({ dir, configPath: config, history: false });
    const btc = found.find((f) => f.asset === "btc:bitcoin")!;
    expect(btc.verdict).toBe("partial");
    applyCustody(found, config);
    const cfg = JSON.parse(readFileSync(config, "utf8"));
    expect(cfg.live.assets["btc:bitcoin"].custody).toEqual([]);
    expect(cfg.live.assets["btc:bitcoin"].hotWallets).toEqual(["bc1hot"]);
  });

  it("searches the hot wallet's older history for the vault that refills it", async () => {
    // 10 BTC owed. The hot wallet (2) and the sweep target (5) hold 7: not enough on their own.
    // 30 transactions back, a vault refilled the hot wallet and still holds 3; an exchange that
    // once paid it holds 40, which no bridge reserve of 10 BTC would, so it is left out.
    const pay = (i: number) => ({ txid: `p${i}`, vin: [{ prevout: { scriptpubkey_address: "bc1hot", value: 1_000_000 } }], vout: [{ scriptpubkey_address: `bc1user${i}`, value: 990_000 }] });
    const page1 = [{ txid: "back", vin: [{ prevout: { scriptpubkey_address: "bc1hot", value: 50_000_000 } }], vout: [{ scriptpubkey_address: "bc1vault", value: 50_000_000 }] }, ...Array.from({ length: 24 }, (_, i) => pay(i))];
    const page2 = [
      { txid: "refill", vin: [{ prevout: { scriptpubkey_address: "bc1vault", value: 300_000_000 } }], vout: [{ scriptpubkey_address: "bc1hot", value: 150_000_000 }, { scriptpubkey_address: "bc1vault", value: 149_990_000 }] },
      { txid: "buy", vin: [{ prevout: { scriptpubkey_address: "bc1exchange", value: 20_000_000 } }], vout: [{ scriptpubkey_address: "bc1hot", value: 20_000_000 }] },
    ];
    const deep: Record<string, unknown> = {
      "/address/bc1hot/txs/chain": page1,
      "/address/bc1hot/txs/chain/p23": page2,
      "/address/bc1vault": { chain_stats: { funded_txo_sum: 300_000_000, spent_txo_sum: 0 } },
      "/address/bc1exchange": { chain_stats: { funded_txo_sum: 4_000_000_000, spent_txo_sum: 0 } },
    };
    const base = world(5);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const v = String(url).startsWith("https://mempool.space/api") ? deep[String(url).slice("https://mempool.space/api".length)] : undefined;
      return v !== undefined ? new Response(JSON.stringify(v)) : base(url, init);
    }));
    const { dir, config } = setup();
    const found = await findCustody({ dir, configPath: config, history: false });
    const btc = found.find((f) => f.asset === "btc:bitcoin")!;
    const role = (a: string) => btc.addresses.find((x) => x.address === a)?.role;
    expect(role("bc1vault")).toBe("treasury");
    expect(btc.addresses.find((x) => x.address === "bc1vault")!.evidence).toMatch(/also received from it/);
    expect(role("bc1exchange")).toBe("other service");
    // Users paid by the hot wallet are never taken for the bridge's own wallets.
    expect(btc.addresses.some((x) => x.address.startsWith("bc1user"))).toBe(false);
    expect(btc.coveragePpm).toBe(1_000_000);
    expect(btc.verdict).toBe("complete");
    applyCustody(found, config);
    expect(JSON.parse(readFileSync(config, "utf8")).live.assets["btc:bitcoin"].custody).toEqual(["bc1hot", "bc1cold", "bc1vault"]);
  });

  it("splits a hot wallet's payouts into ones users asked for and ones nobody did", () => {
    const at = 1_790_000_000; // seconds
    const tx = (txid: string, t: number, outs: [string, number][]) => ({ txid, status: { block_time: t }, vin: [{ prevout: { scriptpubkey_address: "bc1hot", value: 1e9 } }], vout: outs.map(([a, v]) => ({ scriptpubkey_address: a, value: v })) });
    const txs = [
      tx("a", at + 100, [["BC1QUSER", 10_000_000], ["bc1hot", 5_000_000]]), // a user, written in capitals in the memo; change back
      tx("b", at + 200, [["bc1elsewhere", 200_000_000]]),
      tx("c", at + 300, [["bc1elsewhere", 20_000_000], ["bc1hot2", 1_000_000]]), // a move to the second hot wallet is internal
      tx("d", at - 100, [["bc1old", 7_000_000]]), // before the window
      { txid: "e", status: { block_time: at + 400 }, vin: [{ prevout: { scriptpubkey_address: "bc1dep", value: 3_000_000 } }], vout: [{ scriptpubkey_address: "bc1hot", value: 3_000_000 }] }, // a sweep in
    ];
    const r = reconcilePayouts(txs, new Set(["bc1hot", "bc1hot2"]), new Set(["bc1quser"]), at * 1000);
    expect(r.toUsers).toBe(10_000_000n);
    expect([...r.elsewhere]).toEqual([["bc1elsewhere", { value: 220_000_000n, payments: 2 }]]);
  });

  it("shows where the hot wallet sent coins no user withdrew", async () => {
    const now = Date.now();
    const h = 3_600_000;
    const ago = [12, 11.5, 8, 7, 6, 5];
    const dir = mkdtempSync(join(tmpdir(), "custody-"));
    writeFileSync(join(dir, "bridge-events-1.jsonl"), ago.map((x, i) => JSON.stringify({ kind: "withdrawal", asset: "btc:bitcoin", amount: "10000000", account: `u${i}.near`, nearTx: `W${i}`, atMs: now - x * h, destAddress: `bc1u${i}` })).join("\n") + "\n");
    const config = join(dir, "watchtower.config.json");
    writeFileSync(config, JSON.stringify({ contractId: "watchtower.you.testnet", live: { assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near" } } } }));
    const pay = (txid: string, atMs: number, to: string, value: number) => ({ txid, status: { block_time: Math.floor(atMs / 1000) }, vin: [{ prevout: { scriptpubkey_address: "bc1hot", value: value + 10_000 } }], vout: [{ scriptpubkey_address: to, value }] });
    const history = [pay("m", now - 2 * h, "bc1mystery", 200_000_000), ...ago.map((x, i) => pay(`p${i}`, now - x * h + 600_000, `bc1u${i}`, 9_990_000)).reverse()];
    const extra: Record<string, unknown> = {
      "/address/bc1hot/txs/chain": history,
      "/address/bc1mystery": { chain_stats: { funded_txo_sum: 200_000_000, spent_txo_sum: 0 } },
    };
    const base = world(8.5);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const v = String(url).startsWith("https://mempool.space/api") ? extra[String(url).slice("https://mempool.space/api".length)] : undefined;
      return v !== undefined ? new Response(JSON.stringify(v)) : base(url, init);
    }));
    const btc = (await findCustody({ dir, configPath: config, history: false })).find((f) => f.asset === "btc:bitcoin")!;
    // The window starts three hours after the oldest withdrawal: 4 withdrawals fall inside it.
    expect(btc.reconciliation).toMatchObject({ withdrawals: 4, withdrawn: "40000000", paidToUsers: "39960000", paidElsewhere: "200000000", paymentsElsewhere: 1 });
    const mystery = btc.addresses.find((x) => x.address === "bc1mystery")!;
    expect(mystery.role).toBe("unmatched payout");
    expect(mystery.balance).toBe("200000000");
    // Reported, never counted as the bridge's reserve: 2 BTC hot + nothing else of 10 owed.
    expect(btc.found).toBe("200000000");
    // Worked back: 8 BTC missing now, 6 at the window's start; the 2 BTC payment is when it grew.
    const g = btc.reconciliation!.gapTimeline!;
    expect(g[0]!.gap).toBe("599990000");
    expect(g[g.length - 1]!.gap).toBe("800000000");
    expect(btc.reconciliation!.paymentsToUsers).toBe(4);
  });

  it("a deep scan measures the coins still waiting in users' deposit addresses", async () => {
    // 10 BTC owed; hot 2 + cold 7.5 = 95%. Of 30 more deposits, 10 still sit unswept with 0.05 BTC each.
    const dir = mkdtempSync(join(tmpdir(), "custody-"));
    const deposits = Array.from({ length: 30 }, (_, i) => ({ kind: "deposit", asset: "btc:bitcoin", amount: "5000000", account: `d${i}.near`, nearTx: `D${i}`, atMs: 1000 - i, sourceTxRef: H(String.fromCharCode(103 + (i % 15))) + i }));
    writeFileSync(join(dir, "bridge-events-1.jsonl"), [
      { kind: "deposit", asset: "btc:bitcoin", amount: "50000000", account: "bob.near", nearTx: "NEAR_TX_2", atMs: 5000, sourceTxRef: DEPOSIT },
      { kind: "withdrawal", asset: "btc:bitcoin", amount: "30000000", account: "alice.near", nearTx: "NEAR_TX_1", atMs: 4000 },
      ...deposits,
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const config = join(dir, "watchtower.config.json");
    writeFileSync(config, JSON.stringify({ contractId: "watchtower.you.testnet", live: { assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near" } } } }));
    const extra: Record<string, unknown> = {};
    deposits.forEach((d, i) => {
      extra[`/tx/${d.sourceTxRef}`] = { txid: d.sourceTxRef, vin: [{ prevout: { scriptpubkey_address: `bc1user${i}`, value: 6_000_000 } }], vout: [{ scriptpubkey_address: `bc1d${i}`, value: 5_000_000 }] };
      extra[`/address/bc1d${i}`] = { chain_stats: { funded_txo_sum: 5_000_000, spent_txo_sum: i < 10 ? 0 : 5_000_000 } };
    });
    const base = world(7.5);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const v = String(url).startsWith("https://mempool.space/api") ? extra[String(url).slice("https://mempool.space/api".length)] : undefined;
      return v !== undefined ? new Response(JSON.stringify(v)) : base(url, init);
    }));
    const shallow = (await findCustody({ dir, configPath: config, history: false })).find((f) => f.asset === "btc:bitcoin")!;
    expect(shallow.depositsTraced).toBe(12);
    const btc = (await findCustody({ dir, configPath: config, history: false, deep: 100 })).find((f) => f.asset === "btc:bitcoin")!;
    expect(btc.depositsTraced).toBe(31);
    expect(btc.coveragePpm).toBe(950_000);
    // bc1waiting (0.3, from the bridge's API) plus the 10 unswept: 0.8 BTC waiting, 103% with them.
    expect(btc.unswept).toBe("80000000");
    expect(btc.unsweptAddresses).toBe(11);
    expect(btc.coverageWithUnsweptPpm).toBe(1_030_000);
    expect(btc.verdict).toBe("partial");
  }, 30_000);

  it("uses the HOT bridge's locker as custody on BSC, read with the right token", async () => {
    const LOCKER = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";
    const USDT = "0x55d398326f99059ff775485246999027b3197955";
    const E = 10n ** 18n;
    const supply: Record<string, bigint> = { "56_2CMMyVTGZkeyNZTSvS5sarzfir6g": 1000n * E, "56_11111111111111111111": 19n * E };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body?.id, result }));
      if (body?.method === "query" && body.params.account_id === "v2_1.omni.hot.tg") {
        const args = JSON.parse(Buffer.from(body.params.args_base64, "base64").toString());
        return ok({ result: [...Buffer.from(JSON.stringify(String(supply[args.token_id])))] });
      }
      if (String(url).includes("bsc") && body?.method === "eth_call") {
        expect(body.params[0].to).toBe(USDT);
        expect(body.params[0].data.endsWith(LOCKER.slice(2))).toBe(true);
        return ok("0x" + (1050n * E).toString(16));
      }
      if (String(url).includes("bsc") && body?.method === "eth_getBalance") return ok("0x" + (20n * E).toString(16));
      return new Response("not here", { status: 404 });
    }));
    const dir = mkdtempSync(join(tmpdir(), "custody-"));
    const config = join(dir, "watchtower.config.json");
    writeFileSync(config, JSON.stringify({ contractId: "watchtower.you.testnet", live: { assets: {
      "usdt:bsc": { custody: [], nearContract: "v2_1.omni.hot.tg", mtTokenId: "56_2CMMyVTGZkeyNZTSvS5sarzfir6g" },
      "bnb:bsc": { custody: [], nearContract: "v2_1.omni.hot.tg", mtTokenId: "56_11111111111111111111" },
    } } }));
    const found = await findCustody({ dir, configPath: config, history: false, only: ["usdt:bsc", "bnb:bsc"] });
    const usdt = found.find((f) => f.asset === "usdt:bsc")!;
    const bnb = found.find((f) => f.asset === "bnb:bsc")!;
    expect(usdt.addresses).toMatchObject([{ address: LOCKER, role: "treasury", balance: (1050n * E).toString() }]);
    expect(usdt.coveragePpm).toBe(1_050_000);
    expect(usdt.verdict).toBe("complete");
    expect(bnb.coveragePpm).toBe(1_052_631);
    applyCustody(found, config);
    const cfg = JSON.parse(readFileSync(config, "utf8")).live.assets;
    // The watchers read USDT's balance from the USDT contract, and BNB's natively.
    expect(cfg["usdt:bsc"]).toMatchObject({ custody: [LOCKER], token: USDT, hotWallets: [LOCKER] }); // the locker pays withdrawals too
    expect(cfg["bnb:bsc"].custody).toEqual([LOCKER]);
    expect(cfg["bnb:bsc"].token).toBeUndefined();
  });

  it("measures a steady shortfall's usual level and how far deposits push it up", () => {
    const H = 3_600_000;
    const now = 100 * H;
    const owed = 10_000_000_000n; // 100 BTC
    // Shortfall now 2 BTC. Two hours ago a 5 BTC deposit was credited and swept 3 hours later... worked back:
    // at 10h a 5 BTC credit (gap +5), at 13h its sweep into the treasury (gap -5).
    const near = [{ atMs: 10 * H, delta: 500_000_000n }];
    const hot = [{ atMs: 13 * H, delta: 500_000_000n }];
    const p = gapProfile(200_000_000n, near, hot, 0, now, owed);
    expect(p.baselineGap).toBe("200000000");
    expect(p.maxRaise).toBe("500000000");
    expect(p.maxRaiseMs).toBe(3 * H);
    expect(p.alarmGap).toBe(String(200_000_000n + 750_000_000n)); // 1.5x the biggest raise
    expect(p.persistMs).toBe(4.5 * H);
    expect(p.smallGap).toBe("5000000"); // 0.05% of what is owed
  });

  it("writes partly verified only when asked, and drops it once fully covered", () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-"));
    const config = join(dir, "watchtower.config.json");
    writeFileSync(config, JSON.stringify({ contractId: "w.testnet", live: { assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near" } } } }));
    const finding: AssetFinding = {
      asset: "btc:bitcoin", decimals: 8, supply: "8731770000", bridgeHeld: "70000", issuerAccounts: ["btc.omft.near", "omft.near"], withdrawalsSeen: 829, withdrawalsTraced: 24, depositsSeen: 1268, depositsTraced: 12,
      addresses: [{ address: "1HOT", role: "hot wallet", evidence: "paid 24 withdrawals", balance: "8510480000" }, { address: "1DEP", role: "deposit address", evidence: "x", balance: "430000" }],
      verdict: "partial", coveragePpm: 974_660, notes: [],
      partial: { baselineGap: "221210000", smallGap: "4365850", alarmGap: "250000000", persistMs: 7_200_000, sinceMs: 1, measuredAtMs: 2, maxRaise: "19000000", maxRaiseMs: 4_800_000 },
    };
    applyCustody([finding], config);
    expect(JSON.parse(readFileSync(config, "utf8")).live.assets["btc:bitcoin"].partial).toBeUndefined();
    applyCustody([finding], config, { partial: true });
    const btc = JSON.parse(readFileSync(config, "utf8")).live.assets["btc:bitcoin"];
    expect(btc.custody).toEqual(["1HOT"]); // never a user's deposit address
    expect(btc.partial).toEqual({ baselineGap: "221210000", smallGap: "4365850", alarmGap: "250000000", persistMs: 7_200_000, sinceMs: 1, measuredAtMs: 2 });
    expect(btc.issuerAccounts).toEqual(["btc.omft.near", "omft.near"]);
    applyCustody([{ ...finding, verdict: "complete", coveragePpm: 1_001_000, partial: undefined }], config);
    expect(JSON.parse(readFileSync(config, "utf8")).live.assets["btc:bitcoin"].partial).toBeUndefined();
  });

  it("offers partly verified only when the treasury reconciles and the shortfall is steady", async () => {
    const H = 3_600_000;
    const now = Date.now();
    const start = now - 31 * H;
    const run = async (extraInflow: boolean) => {
      const dir = mkdtempSync(join(tmpdir(), "custody-"));
      // 60 withdrawals of 0.1 BTC over 30 hours, each paid 10 minutes later from the treasury.
      const ws = Array.from({ length: 60 }, (_, i) => ({ kind: "withdrawal", asset: "btc:bitcoin", amount: "10000000", account: `u${i}.near`, nearTx: `W${i}`, atMs: start + i * 30 * 60_000, destAddress: `bc1u${i}` }));
      writeFileSync(join(dir, "bridge-events-1.jsonl"), ws.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const config = join(dir, "watchtower.config.json");
      writeFileSync(config, JSON.stringify({ contractId: "w.testnet", live: { assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near" } } } }));
      const pay = ws.map((w, i) => ({ txid: `p${i}`, status: { block_time: Math.floor((w.atMs + 600_000) / 1000) }, vin: [{ prevout: { scriptpubkey_address: "bc1hot", value: 10_001_000 } }], vout: [{ scriptpubkey_address: w.destAddress, value: 10_000_000 }] }));
      // A refill no NEAR deposit explains, half way through: the shortfall moved.
      if (extraInflow) pay.push({ txid: "x", status: { block_time: Math.floor((start + 15 * H) / 1000) }, vin: [{ prevout: { scriptpubkey_address: "bc1someone", value: 50_000_000 } }], vout: [{ scriptpubkey_address: "bc1hot", value: 50_000_000 }] });
      const extra: Record<string, unknown> = {
        "/address/bc1hot/txs/chain": pay.sort((a, b) => b.status.block_time - a.status.block_time),
        "/address/bc1hot": { chain_stats: { funded_txo_sum: 975_000_000, spent_txo_sum: 0 } }, // 9.75 of 10 BTC owed
        "/address/bc1someone": { chain_stats: { funded_txo_sum: 1_000_000_000_000, spent_txo_sum: 0 } },
      };
      const base = world(0);
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
        const v = String(url).startsWith("https://mempool.space/api") ? extra[String(url).slice("https://mempool.space/api".length)] : undefined;
        return v !== undefined ? new Response(JSON.stringify(v)) : base(url, init);
      }));
      return (await findCustody({ dir, configPath: config, history: false })).find((f) => f.asset === "btc:bitcoin")!;
    };
    const steady = await run(false);
    expect(steady.partialRefused).toBeUndefined();
    expect(steady.partial).toBeDefined();
    // 0.25 BTC short now; earlier in the window it was smaller by the miner fees paid since.
    expect(Number(steady.partial!.baselineGap)).toBeGreaterThan(24_940_000);
    expect(Number(steady.partial!.baselineGap)).toBeLessThanOrEqual(25_000_000);
    // A withdrawal waits 10 minutes for its payout: never more than that far below usual.
    expect(Number(steady.partial!.maxRaise)).toBeLessThan(100_000);
    const moved = await run(true);
    expect(moved.partial).toBeUndefined();
    expect(moved.partialRefused).toMatch(/changed during the window/);
  }, 30_000);

  it("counts the wallets NEAR Intents itself publishes", async () => {
    // Hot 2 + cold 5 = 7 of 10 BTC; the published treasury holds the other 3.
    const base = world(5);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/address/1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra")) return new Response(JSON.stringify({ chain_stats: { funded_txo_sum: 300_000_000, spent_txo_sum: 0 } }));
      return base(url, init);
    }));
    const { dir, config } = setup();
    const btc = (await findCustody({ dir, configPath: config, history: false })).find((f) => f.asset === "btc:bitcoin")!;
    const listed = btc.addresses.find((x) => x.address === "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra")!;
    expect(listed.role).toBe("treasury");
    expect(listed.evidence).toMatch(/listed by NEAR Intents as its treasury/);
    expect(btc.coveragePpm).toBe(1_000_000);
    expect(btc.verdict).toBe("complete");
  });

  it("reads the home-chain token from a PoA contract name", () => {
    expect(homeToken("eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near")).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(homeToken("btc.omft.near")).toBeUndefined();
  });
});

describe("bridge history from the transactions API", () => {
  it("finds recent withdrawals in a token contract's history, with their payout address", async () => {
    const burn = `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_burn", data: [{ owner_id: "intents.near", amount: "30000000", memo: "WITHDRAW_TO:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" }] })}`;
    const mtBurn = `EVENT_JSON:${JSON.stringify({ standard: "nep245", version: "1.0.0", event: "mt_burn", data: [{ owner_id: "alice.near", token_ids: ["nep141:btc.omft.near"], amounts: ["30000000"] }] })}`;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(url).endsWith("/v0/account")) {
        return new Response(JSON.stringify(body.account_id === "btc.omft.near" ? { account_txs: [{ transaction_hash: "TXW", tx_block_height: 200, tx_block_timestamp: "1790000000000000000" }], resume_token: "", txs_count: 1 } : { account_txs: [], resume_token: "", txs_count: 0 }));
      }
      if (String(url).endsWith("/v0/transactions")) {
        return new Response(JSON.stringify({ transactions: [{ transaction: { hash: "TXW" }, receipts: [
          { receipt: { receipt_id: "r1" }, execution_outcome: { id: "r1", outcome: { executor_id: "intents.near", logs: [mtBurn] } } },
          { receipt: { receipt_id: "r2" }, execution_outcome: { id: "r2", outcome: { executor_id: "btc.omft.near", logs: [burn] } } },
        ] }] }));
      }
      return new Response("no", { status: 404 });
    }));
    const ev = await historyEvents([{ contract: "btc.omft.near", asset: "btc:bitcoin", chain: "bitcoin" }, { contract: "eth.omft.near", asset: "eth:ethereum", chain: "ethereum" }], "intents.near");
    expect(ev).toEqual([expect.objectContaining({ kind: "withdrawal", asset: "btc:bitcoin", nearTx: "TXW", account: "alice.near", destAddress: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" })]);
  });

  it("finds deposits with a second query: transactions sent to the token contract", async () => {
    const ev = (standard: string, event: string, data: unknown[]) => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data })}`;
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(url).endsWith("/v0/account")) {
        bodies.push(body);
        // The event filter only ever returns burns; mints come back for transactions sent to the contract.
        const rows = body.is_real_receiver ? [{ transaction_hash: "TXD", tx_block_height: 300, tx_block_timestamp: "1790000000000000000" }] : [];
        return new Response(JSON.stringify({ account_txs: rows, resume_token: "", txs_count: rows.length }));
      }
      if (String(url).endsWith("/v0/transactions")) {
        return new Response(JSON.stringify({ transactions: [{ transaction: { hash: "TXD" }, receipts: [
          { execution_outcome: { id: "m1", outcome: { executor_id: "btc.omft.near", logs: [ev("nep141", "ft_mint", [{ owner_id: "intents.near", amount: "50000000", memo: "deposit" }])] } } },
          { execution_outcome: { id: "m2", outcome: { executor_id: "intents.near", logs: [ev("nep245", "mt_mint", [{ owner_id: "bob.near", token_ids: ["nep141:btc.omft.near"], amounts: ["50000000"] }])] } } },
        ] }] }));
      }
      return new Response("no", { status: 404 });
    }));
    const out = await historyEvents([{ contract: "btc.omft.near", asset: "btc:bitcoin", chain: "bitcoin" }], "intents.near");
    expect(out).toEqual([expect.objectContaining({ kind: "deposit", asset: "btc:bitcoin", account: "bob.near", nearTx: "TXD" })]);
    expect(bodies.map((b) => Object.keys(b).filter((k) => k.startsWith("is_") && k !== "is_success"))).toEqual([["is_event_log"], ["is_real_receiver"]]);
  });
});
