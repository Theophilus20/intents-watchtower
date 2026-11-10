import { describe, expect, it } from "vitest";
import { assetsFromTokens, describeHttpError, hotHomeToken, hotTreasury, destFromMemo, parseShardLayout, shardOf, shardsFromBlock, EsploraReader, EvmReader, fillsFromTokenDiffs, LiveCollector, NeardataIndexer, parseEventLog, realAddresses, sourceRefFromMemo, supplySource, type NeardataBlock } from "@watchtower/collectors";

const ev = (standard: string, event: string, data: unknown[]) => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data })}`;

function block(outcomes: { executor: string; tx: string; logs: string[] }[]): NeardataBlock {
  return {
    block: { header: { height: 150_000_000, timestamp_nanosec: "1790000000000000000", hash: "h" } },
    shards: [{ receipt_execution_outcomes: outcomes.map((o, i) => ({ receipt: { receiver_id: o.executor, predecessor_id: "x", receipt_id: `r${i}` }, execution_outcome: { id: `o${i}`, outcome: { logs: o.logs, executor_id: o.executor, status: {} } }, tx_hash: o.tx })) }],
  };
}

describe("NEP-297 parsing", () => {
  it("parses event logs and ignores everything else", () => {
    expect(parseEventLog(ev("nep141", "ft_mint", [{ owner_id: "a", amount: "1" }]))?.event).toBe("ft_mint");
    expect(parseEventLog("Transfer 5 from a to b")).toBeNull();
    expect(parseEventLog("EVENT_JSON:{broken")).toBeNull();
  });
  it("pulls a source tx out of bridge memos", () => {
    expect(sourceRefFromMemo(`BRIDGED_FROM:{"tx":"0x${"ab".repeat(32)}"}`)).toBe(`0x${"ab".repeat(32)}`);
    expect(sourceRefFromMemo("hello")).toBeUndefined();
  });
});

describe("neardata indexer", () => {
  const idx = new NeardataIndexer("http://n", [{ contract: "btc.omft.near", asset: "btc:bitcoin", chain: "bitcoin" }], "intents.near", {}, (t) => ({ "nep141:btc.omft.near": "btc:bitcoin", "nep141:usdc.near": "usdc:near" })[t], (_t, a) => a / 1000n);

  it("turns bridge mints into credits, attributing intents.near mints to the real user", () => {
    const b = idx.parse(block([
      { executor: "btc.omft.near", tx: "T1", logs: [ev("nep141", "ft_mint", [{ owner_id: "intents.near", amount: "150000000", memo: `deposit ${"cd".repeat(32)}` }])] },
      { executor: "intents.near", tx: "T1", logs: [ev("nep245", "mt_mint", [{ owner_id: "alice.near", token_ids: ["nep141:btc.omft.near"], amounts: ["150000000"] }])] },
      { executor: "btc.omft.near", tx: "T2", logs: [ev("nep141", "ft_burn", [{ owner_id: "bob.near", amount: "5000" }])] },
    ]));
    expect(b.timeMs).toBe(1_790_000_000_000);
    expect(b.credits).toEqual([expect.objectContaining({ asset: "btc:bitcoin", amount: 150_000_000n, account: "alice.near", nearTx: "T1", sourceTxRef: "cd".repeat(32) })]);
    expect(b.withdrawals).toEqual([expect.objectContaining({ asset: "btc:bitcoin", amount: 5000n, account: "bob.near", destChain: "bitcoin" })]);
  });

  it("derives solver fills from DIP-4 token_diff pairs", () => {
    const diffs = new Map([["TX", [
      { account_id: "user.near", intent_hash: "i1", diff: { "nep141:btc.omft.near": "-100000", "nep141:usdc.near": "96000000" } },
      { account_id: "solver-a.near", intent_hash: "i2", diff: { "nep141:btc.omft.near": "100000", "nep141:usdc.near": "-96000000" } },
    ]]]);
    const fills = fillsFromTokenDiffs(diffs, 1, (t) => ({ "nep141:btc.omft.near": "btc:bitcoin", "nep141:usdc.near": "usdc:near" })[t], () => 9_600_000n);
    expect(fills).toEqual([{ id: "TX:solver-a.near", route: "btc:bitcoin->usdc:near", solver: "solver-a.near", usdCents: 9_600_000n, atMs: 1 }]);
  });
});

describe("chain readers", () => {
  const routes = (map: Record<string, unknown>) => (async (url: string, init?: RequestInit) => {
    const key = init?.body ? JSON.parse(String(init.body)).method : url;
    const v = Object.entries(map).find(([k]) => String(key).endsWith(k))?.[1];
    if (v === undefined) return new Response("missing " + key, { status: 404 });
    return new Response(JSON.stringify(init?.body ? { jsonrpc: "2.0", id: 1, result: v } : v));
  }) as unknown as typeof fetch;

  it("reads confirmed Esplora balances and the tip", async () => {
    const r = new EsploraReader("bitcoin", "https://mempool.space/api", { fetch: routes({ "/address/bc1a": { chain_stats: { funded_txo_sum: 500, spent_txo_sum: 100 }, mempool_stats: { funded_txo_sum: 999, spent_txo_sum: 0 } }, "/address/bc1b": { chain_stats: { funded_txo_sum: 50, spent_txo_sum: 0 } }, "/blocks/tip/height": 900_000, "/blocks/900000": [{ height: 900_000, timestamp: 1_790_000_000 }] }) });
    expect(await r.balance(["bc1a", "bc1b"])).toBe(450n);
    expect(await r.head()).toMatchObject({ chain: "bitcoin", headHeight: 900_000, headTimeMs: 1_790_000_000_000 });
  });

  it("falls back to another Bitcoin server when the configured one is unreachable", async () => {
    const asked: string[] = [];
    const fetch = (async (url: string) => {
      asked.push(String(url));
      if (String(url).startsWith("https://mempool.space")) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ chain_stats: { funded_txo_sum: 700, spent_txo_sum: 200 } }));
    }) as unknown as typeof globalThis.fetch;
    const r = new EsploraReader("bitcoin", "https://mempool.space/api", { fetch, retries: 0 });
    expect(await r.balance(["bc1a"])).toBe(500n);
    expect(await r.balance(["bc1b"])).toBe(500n);
    // After one failure the working server is asked first.
    expect(asked).toEqual(["https://mempool.space/api/address/bc1a", "https://blockstream.info/api/address/bc1a", "https://blockstream.info/api/address/bc1b"]);
  });

  it("reads EVM native and ERC-20 balances", async () => {
    const r = new EvmReader("ethereum", "https://rpc", { fetch: routes({ eth_getBalance: "0x10", eth_call: "0x0de0b6b3a7640000" }) });
    expect(await r.balance(["0xabc"])).toBe(16n);
    expect(await r.balance(["0xabc"], "0xtoken")).toBe(10n ** 18n);
  });
});

describe("1Click token list", () => {
  it("maps tokens to assets, chains, bridges and prices", () => {
    const { assets, prices, byTokenId } = assetsFromTokens([
      { assetId: "nep141:btc.omft.near", decimals: 8, blockchain: "btc", symbol: "BTC", price: 96000, priceUpdatedAt: "2026-11-04T10:00:00Z" },
      { assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6, blockchain: "near", symbol: "USDC", price: "1.0001", priceUpdatedAt: "2026-11-04T10:00:00Z" },
    ]);
    expect(assets.map((a) => [a.key, a.bridge, !!a.stable])).toEqual([["btc:bitcoin", "poa", false], ["usdc:near", "native", true]]);
    expect(prices[1]!.priceMicroUsd).toBe(1_000_100n);
    expect(byTokenId.get("nep141:btc.omft.near")).toBe("btc:bitcoin");
  });
});

describe("HOT bridge tokens", () => {
  it("reads the home token back out of a HOT omni token id", () => {
    // BSC USDT, base58-encoded the way HOT's SDK does it.
    expect(hotHomeToken("56_2CMMyVTGZkeyNZTSvS5sarzfir6g")).toEqual({ chainId: 56, token: "0x55d398326f99059ff775485246999027b3197955" });
    expect(hotHomeToken("56_11111111111111111111")).toEqual({ chainId: 56 }); // native BNB
    expect(hotHomeToken("1117_abc")).toBeUndefined(); // not EVM-shaped
    expect(hotHomeToken("btc.omft.near")).toBeUndefined();
  });

  it("knows HOT's locker on each EVM chain", () => {
    expect(hotTreasury(56)).toBe("0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd");
    expect(hotTreasury(36900)).toBe("0x4a3b9d07a9a1e3d9dfb0a6edfc87384f8f424003");
  });
});

describe("live collector safety", () => {
  it("reads where a withdrawal is headed and where a token's supply lives", () => {
    expect(destFromMemo("WITHDRAW_TO:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")).toBe("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh");
    expect(destFromMemo("hello")).toBeUndefined();
    expect(supplySource("nep141:ltc.omft.near")).toEqual({ nearContract: "ltc.omft.near" });
    expect(supplySource("nep245:v2_1.omni.hot.tg:56_11111111111111111111")).toEqual({ nearContract: "v2_1.omni.hot.tg", mtTokenId: "56_11111111111111111111" });
    expect(realAddresses(["<bc1… custody address>", "", "bc1qabc"])).toEqual(["bc1qabc"]);
  });

  it("takes tokens the bridge holds itself off the credited supply", async () => {
    const fetch = (async (url: string, init?: RequestInit) => {
      if (init?.body) {
        const { method, id, params } = JSON.parse(String(init.body));
        if (method === "query") {
          const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString());
          // 10 BTC credited, 0.6 of it held by the bridge's own minter account.
          // 0.6 BTC held by omft.near directly, and 0.2 BTC by it inside the intents ledger.
          const value = params.method_name === "ft_total_supply" ? "1000000000" : params.method_name === "mt_balance_of" ? (args.account_id === "omft.near" && args.token_id === "nep141:btc.omft.near" ? "20000000" : "0") : args.account_id === "omft.near" ? "60000000" : "0";
          return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { result: [...Buffer.from(JSON.stringify(value))] } }));
        }
      }
      return new Response("down", { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const c = new LiveCollector({
      near: { rpcUrl: "https://rpc", neardataUrl: "https://nd", intentsContract: "intents.near" },
      oneClickUrl: "https://1click",
      chains: {},
      assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near", issuerAccounts: ["omft.near"] } },
      http: { fetch, retries: 0, timeoutMs: 1000 },
    });
    const b = await c.collect(Date.UTC(2026, 10, 5, 7));
    expect(b.supply!.find((x) => x.asset === "btc:bitcoin")!.credited).toBe(920_000_000n); // 10 − 0.6 − 0.2
  });

  it("never turns a missing custody list into a zero balance, and tracks unlisted bridged tokens", async () => {
    const fetch = (async (url: string) => {
      if (String(url).endsWith("/v0/tokens")) {
        return new Response(JSON.stringify([
          { assetId: "nep141:btc.omft.near", blockchain: "btc", symbol: "BTC", decimals: 8, price: "90000", priceUpdatedAt: "2026-11-04T19:00:00Z" },
          { assetId: "nep141:ltc.omft.near", blockchain: "ltc", symbol: "LTC", decimals: 8, price: "80", priceUpdatedAt: "2026-11-04T19:00:00Z" },
        ]));
      }
      return new Response("down", { status: 503 });
    }) as unknown as typeof globalThis.fetch;
    const c = new LiveCollector({
      near: { rpcUrl: "https://rpc", neardataUrl: "https://neardata", intentsContract: "intents.near" },
      oneClickUrl: "https://1click",
      chains: { bitcoin: { kind: "esplora", url: "https://esplora" } },
      assets: { "btc:bitcoin": { custody: ["<bc1… custody address 1>"], nearContract: "btc.omft.near" } },
      http: { fetch, retries: 0, timeoutMs: 1000 },
    });
    const b = await c.collect(Date.UTC(2026, 10, 4, 19, 30));
    expect(b.custody).toEqual([]);
    expect(c.assets.get("ltc:litecoin")).toMatchObject({ nearContract: "ltc.omft.near", custody: [] });
  });

  it("reads a withdrawal from a token contract that logs no burn (transfer to itself with WITHDRAW_TO)", () => {
    const ix = new NeardataIndexer("https://x", [{ contract: "sol.omft.near", asset: "sol:solana", chain: "solana" }]);
    const out = ix.parse(block([
      { executor: "intents.near", tx: "TS", logs: [ev("nep245", "mt_burn", [{ owner_id: "alice.near", token_ids: ["nep141:sol.omft.near"], amounts: ["2000000000"] }])] },
      { executor: "sol.omft.near", tx: "TS", logs: [ev("nep141", "ft_transfer", [{ old_owner_id: "intents.near", new_owner_id: "sol.omft.near", amount: "2000000000", memo: "WITHDRAW_TO:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }])] },
      // An ordinary transfer between users is not a withdrawal.
      { executor: "sol.omft.near", tx: "TU", logs: [ev("nep141", "ft_transfer", [{ old_owner_id: "a.near", new_owner_id: "b.near", amount: "5" }])] },
    ]));
    expect(out.withdrawals).toHaveLength(1);
    expect(out.withdrawals[0]).toMatchObject({ asset: "sol:solana", account: "alice.near", nearTx: "TS", destAddress: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
  });

  it("reads real PoA deposits: the bridge's hand-over names the user and the Bitcoin transaction", () => {
    // Shapes copied from btc.omft.near on mainnet.
    const ix = new NeardataIndexer("https://x", [{ contract: "btc.omft.near", asset: "btc:bitcoin", chain: "bitcoin" }]);
    const txh = "b6d14bbf27af12a42887f84a8a5485a6d56fd192f57f017dc8928243f7ec92aa";
    const out = ix.parse(block([
      { executor: "btc.omft.near", tx: "TD", logs: [
        ev("nep141", "ft_mint", [{ owner_id: "omft.near", amount: "10236" }]),
        ev("nep141", "ft_transfer", [{ old_owner_id: "omft.near", new_owner_id: "intents.near", amount: "10236", memo: `BRIDGED_FROM:${JSON.stringify({ networkType: "btc", chainId: "mainnet", txHash: txh })}` }]),
      ] },
      { executor: "intents.near", tx: "TD", logs: [ev("nep245", "mt_mint", [{ owner_id: "bob.near", token_ids: ["nep141:btc.omft.near"], amounts: ["10236"] }])] },
    ]));
    expect(out.credits).toHaveLength(1);
    expect(out.credits[0]).toMatchObject({ account: "bob.near", amount: 10236n, sourceTxRef: txh, sourceChain: "btc:mainnet" });
  });

  it("reads real SOL withdrawals: a transfer to the bridge's account with WITHDRAW_TO", () => {
    const ix = new NeardataIndexer("https://x", [{ contract: "sol.omft.near", asset: "sol:solana", chain: "solana" }]);
    const out = ix.parse(block([
      { executor: "intents.near", tx: "TW", logs: [ev("nep245", "mt_burn", [{ owner_id: "alice.near", token_ids: ["nep141:sol.omft.near"], amounts: ["3897570501"] }])] },
      { executor: "sol.omft.near", tx: "TW", logs: [ev("nep141", "ft_transfer", [{ old_owner_id: "intents.near", new_owner_id: "2d41f68af1207ee6b96d5002bf60671686facefb5a50e69e7a8aff2431dedc56", amount: "3897570501", memo: "WITHDRAW_TO:BWhc8jQ2G39Nhr6MYXdBBAQTDc2y3fCa9yVSMrKexWF" }])] },
    ]));
    expect(out.withdrawals).toEqual([expect.objectContaining({ account: "alice.near", amount: 3897570501n, destAddress: "BWhc8jQ2G39Nhr6MYXdBBAQTDc2y3fCa9yVSMrKexWF" })]);
  });

  it("records the payout address of a bridge withdrawal", () => {
    const ix = new NeardataIndexer("https://x", [{ contract: "btc.omft.near", asset: "btc:bitcoin", chain: "bitcoin" }]);
    const out = ix.parse(block([{ executor: "btc.omft.near", tx: "T1", logs: [ev("nep141", "ft_burn", [{ owner_id: "alice.near", amount: "1000", memo: "WITHDRAW_TO:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" }])] }]));
    expect(out.withdrawals[0]).toMatchObject({ nearTx: "T1", destAddress: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" });
  });
});

describe("light NEAR indexing", () => {
  const layout = parseShardLayout({ V2: { boundary_accounts: ["aurora", "game.hot.tg", "tge-lockup.sweat"], shard_ids: [5, 1, 7, 3] } })!;

  it("says in a few words why a download failed", () => {
    expect(describeHttpError(Object.assign(new Error("x"), { status: 429 }))).toBe("rate limited (HTTP 429)");
    expect(describeHttpError(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))).toBe("timed out");
  });

  it("reads the version 3 shard layout mainnet uses", () => {
    const v3 = parseShardLayout({ V3: { boundary_accounts: ["aurora", "game.hot.tg"], shard_ids: [10, 11, 12], id_to_index_map: { "10": 0, "11": 1, "12": 2 }, shards_split_map: {}, last_split: 12 } })!;
    expect(shardOf(v3, "intents.near")).toBe(12);
    expect(shardOf(v3, "btc.omft.near")).toBe(11);
    expect(parseShardLayout({ V0: { num_shards: 4 } })).toBeUndefined();
  });

  it("works out the shards from a whole block when the layout is unavailable", () => {
    const blk = (shards: [number, string[]][]): NeardataBlock => ({
      block: { header: { height: 1, timestamp_nanosec: "1", hash: "h" } },
      shards: shards.map(([id, names]) => ({ shard_id: id, receipt_execution_outcomes: names.map((n, i) => ({ receipt: { receiver_id: n, predecessor_id: "x", receipt_id: `r${i}` }, execution_outcome: { id: `${id}-${i}`, outcome: { logs: [], executor_id: n, status: {} } } })) })),
    });
    const b = blk([[3, ["a.near", "aurora"]], [8, ["btc.omft.near", "game.hot.tg"]], [5, ["intents.near", "sweat"]]]);
    expect(shardsFromBlock(b, ["intents.near"])).toEqual([5]);
    expect(shardsFromBlock(b, ["eth.omft.near"])).toEqual([8]); // inside shard 8's range
    expect(shardsFromBlock(b, ["hot.near"])).toEqual([5, 8]); // between two ranges: keep both
  });

  it("puts accounts on the same shard nearcore does", () => {
    expect(shardOf(layout, "a.near")).toBe(5);
    expect(shardOf(layout, "aurora")).toBe(1); // a boundary account starts the next shard
    expect(shardOf(layout, "btc.omft.near")).toBe(1);
    expect(shardOf(layout, "intents.near")).toBe(7);
    expect(shardOf(layout, "v2_1.omni.hot.tg")).toBe(3);
  });

  it("downloads a block's header and only the shards asked for, keeping receipts that logged", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(String(url));
      if (String(url).endsWith("/headers")) return new Response(JSON.stringify({ header: { height: 9, timestamp_nanosec: "1790000000000000000", hash: "h" }, chunks: [{ shard_id: 1 }, { shard_id: 7 }] }));
      return new Response(JSON.stringify({ shard_id: 7, receipt_execution_outcomes: [
        { execution_outcome: { id: "o1", outcome: { logs: [ev("nep141", "ft_burn", [{ owner_id: "a.near", amount: "5", memo: "WITHDRAW_TO:bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" }])], executor_id: "btc.omft.near", status: {} } }, tx_hash: "T" },
        { execution_outcome: { id: "o2", outcome: { logs: [], executor_id: "x.near", status: {} } }, tx_hash: "U" },
      ], state_changes: [{ big: "x".repeat(1000) }] }));
    }) as unknown as typeof globalThis.fetch;
    const ix = new NeardataIndexer("https://nd", [{ contract: "btc.omft.near", asset: "btc:bitcoin", chain: "bitcoin" }], "intents.near", { fetch });
    const b = await ix.fetchSlim(9, [1, 7, 3]);
    expect(urls).toEqual(["https://nd/block/9/headers", "https://nd/block/9/shard/1", "https://nd/block/9/shard/7"]); // shard 3 had no chunk
    expect(b!.shards[1]!.receipt_execution_outcomes).toHaveLength(1);
    expect(ix.parse(b!).withdrawals[0]).toMatchObject({ nearTx: "T", amount: 5n });
  });

  it("picks up after a failed download instead of losing that block's events", async () => {
    let head = 100;
    const failing = new Set<number>();
    const fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.body) {
        const { method, id } = JSON.parse(String(init.body));
        const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
        if (method === "block") return ok({ header: { height: head, timestamp_nanosec: String(BigInt(1_790_000_000_000 + head * 600) * 1_000_000n), hash: "h" } });
        if (method === "EXPERIMENTAL_protocol_config") return ok({ shard_layout: { V2: { boundary_accounts: ["m"], shard_ids: [0, 1] } } });
        return new Response("no", { status: 503 });
      }
      const m = /\/block\/(\d+)\/(headers|shard\/(\d+))$/.exec(u);
      if (!m) return new Response("[]");
      const h = Number(m[1]);
      if (failing.has(h)) return new Response("down", { status: 503 });
      if (m[2] === "headers") return new Response(JSON.stringify({ header: { height: h, timestamp_nanosec: String(BigInt(1_790_000_000_000 + h * 600) * 1_000_000n), hash: `b${h}` }, chunks: [{ shard_id: 0 }, { shard_id: 1 }] }));
      if (m[3] !== "0") return new Response(JSON.stringify({ receipt_execution_outcomes: [] })); // sol.omft.near's shard: quiet
      return new Response(JSON.stringify({ receipt_execution_outcomes: [{ execution_outcome: { id: `o${h}`, outcome: { logs: [ev("nep141", "ft_mint", [{ owner_id: "a.near", amount: String(h) }])], executor_id: "btc.omft.near", status: {} } }, tx_hash: `T${h}` }] }));
    }) as unknown as typeof globalThis.fetch;
    const c = new LiveCollector({
      near: { rpcUrl: "https://rpc", neardataUrl: "https://nd", intentsContract: "intents.near" },
      oneClickUrl: "https://1click",
      chains: {},
      assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near" } },
      http: { fetch, retries: 0, timeoutMs: 1000 },
    });
    const far = 1_800_000_000_000;
    const seen: bigint[] = [];
    seen.push(...(await c.collect(far)).credits!.map((x) => x.amount));
    head = 104;
    failing.add(102);
    seen.push(...(await c.collect(far)).credits!.map((x) => x.amount));
    failing.clear();
    seen.push(...(await c.collect(far)).credits!.map((x) => x.amount));
    // The first round reaches a few blocks back; after that every block is seen exactly once.
    expect(seen).toEqual([95n, 96n, 97n, 98n, 99n, 100n, 101n, 102n, 103n, 104n]);
    // intents.near and btc.omft.near sit on shard 0; sol.omft.near (found in the token list) on shard 1.
    expect(c.indexedShards).toEqual([0, 1]);
  });

  it("stops a round at its data limit and carries on from there the next round", async () => {
    const head = 120;
    const t = (h: number) => 1_790_000_000_000 + h * 600;
    const fetch = (async (url: string, init?: RequestInit) => {
      if (init?.body) {
        const { method, id } = JSON.parse(String(init.body));
        const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
        if (method === "block") return ok({ header: { height: head, timestamp_nanosec: String(BigInt(t(head)) * 1_000_000n), hash: "h" } });
        if (method === "EXPERIMENTAL_protocol_config") return ok({ shard_layout: { V2: { boundary_accounts: ["m"], shard_ids: [0, 1] } } });
        return new Response("no", { status: 503 });
      }
      const m = /\/block\/(\d+)\/(headers|shard\/(\d+))$/.exec(String(url));
      if (!m) return new Response("[]");
      const h = Number(m[1]);
      if (m[2] === "headers") return new Response(JSON.stringify({ header: { height: h, timestamp_nanosec: String(BigInt(t(h)) * 1_000_000n), hash: `b${h}` }, chunks: [{ shard_id: 0 }] }));
      // A big shard slice: about 100 kB per block.
      return new Response(JSON.stringify({ pad: "x".repeat(100_000), receipt_execution_outcomes: [{ execution_outcome: { id: `o${h}`, outcome: { logs: [ev("nep141", "ft_mint", [{ owner_id: "a.near", amount: String(h) }])], executor_id: "btc.omft.near", status: {} } }, tx_hash: `T${h}` }] }));
    }) as unknown as typeof globalThis.fetch;
    const c = new LiveCollector({
      near: { rpcUrl: "https://rpc", neardataUrl: "https://nd", intentsContract: "intents.near" },
      oneClickUrl: "https://1click", chains: {},
      assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near" } },
      http: { fetch, retries: 0, timeoutMs: 1000 },
      indexBudgetMb: 0.3, // about 3 blocks
      concurrency: 1,
    });
    await c.collect(t(100)); // first round: sets the cursor
    const seen: bigint[] = [];
    seen.push(...(await c.collect(t(120))).credits!.map((x) => x.amount));
    expect(c.indexStop).toMatch(/data limit for this round \(0.3 MB\)/);
    expect(seen.length).toBeLessThan(6);
    // Next round picks up exactly where this one stopped: no block lost.
    const next = (await c.collect(t(120))).credits!.map((x) => x.amount);
    expect(next[0]).toBe(seen.at(-1)! + 1n);
  });

  it("starts on the first round even though the newest block is past the epoch boundary", async () => {
    let head = 100;
    const t = (h: number) => 1_790_000_000_000 + h * 600;
    const fetch = (async (url: string, init?: RequestInit) => {
      if (init?.body) {
        const { method, id } = JSON.parse(String(init.body));
        const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
        if (method === "block") return ok({ header: { height: head, timestamp_nanosec: String(BigInt(t(head)) * 1_000_000n), hash: "h" } });
        if (method === "EXPERIMENTAL_protocol_config") return ok({ shard_layout: { V2: { boundary_accounts: ["m"], shard_ids: [0, 1] } } });
        return new Response("no", { status: 503 });
      }
      const m = /\/block\/(\d+)\/(headers|shard\/(\d+))$/.exec(String(url));
      if (!m) return new Response("[]");
      const h = Number(m[1]);
      if (m[2] === "headers") return new Response(JSON.stringify({ header: { height: h, timestamp_nanosec: String(BigInt(t(h)) * 1_000_000n), hash: `b${h}` }, chunks: [{ shard_id: 0 }] }));
      return new Response(JSON.stringify({ receipt_execution_outcomes: [{ execution_outcome: { id: `o${h}`, outcome: { logs: [ev("nep141", "ft_mint", [{ owner_id: "a.near", amount: String(h) }])], executor_id: "btc.omft.near", status: {} } }, tx_hash: `T${h}` }] }));
    }) as unknown as typeof globalThis.fetch;
    const c = new LiveCollector({
      near: { rpcUrl: "https://rpc", neardataUrl: "https://nd", intentsContract: "intents.near" },
      oneClickUrl: "https://1click",
      chains: {},
      assets: { "btc:bitcoin": { custody: [], nearContract: "btc.omft.near" } },
      http: { fetch, retries: 0, timeoutMs: 1000 },
    });
    const first = await c.collect(t(98)); // the epoch ended at block 98; the chain is already at 100
    expect(first.credits!.map((x) => x.amount).at(-1)).toBe(98n);
    expect(c.indexedBlocks).toBeGreaterThan(0);
    head = 104;
    const second = await c.collect(t(104));
    expect(second.credits!.map((x) => x.amount)).toEqual([99n, 100n, 101n, 102n, 103n, 104n]);
  });
});
