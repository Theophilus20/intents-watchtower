import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_ASSETS, DEFAULT_ROUTES, parseRoute } from "@watchtower/core";
import { EsploraReader, EvmReader, NEAR_RPC, NearRpc, NeardataIndexer, OneClickClient, SolanaReader, jsonRpc, upgradeNearRpc, type LiveConfig } from "@watchtower/collectors";

/**
 * Readiness check against the real networks. Read-only: it never signs or sends anything.
 *
 *   npm run doctor                              defaults + watchtower.config.json if present
 *   npm run doctor -- --config my.json --contract watchtower.you.testnet --network testnet
 *
 * It answers the questions that decide whether a deployment can produce honest verdicts:
 * can we read NEAR and every home chain right now, are the bridge tokens where we expect,
 * are custody addresses configured, and is the contract reachable with its watchers set up.
 */

type Level = "ok" | "warn" | "fail";
interface Check { area: string; name: string; level: Level; detail: string; fix?: string }

export const DEFAULT_LIVE: LiveConfig = {
  near: { rpcUrl: "https://free.rpc.fastnear.com", neardataUrl: "https://mainnet.neardata.xyz/v0", intentsContract: "intents.near" },
  oneClickUrl: "https://1click.chaindefuser.com",
  chains: {
    bitcoin: { kind: "esplora", url: "https://mempool.space/api" },
    ethereum: { kind: "evm", url: "https://ethereum-rpc.publicnode.com" },
    bsc: { kind: "evm", url: "https://bsc-rpc.publicnode.com" },
    solana: { kind: "solana", url: "https://api.mainnet-beta.solana.com" },
    litecoin: { kind: "esplora", url: "https://litecoinspace.org/api" },
  },
  assets: {},
};

const RPC = NEAR_RPC;

function withTimeout<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s`)), ms))]);
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 120 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

export interface DoctorOptions {
  configPath?: string;
  contractId?: string;
  network?: "testnet" | "mainnet";
  relayer?: string;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<{ checks: Check[]; readyTestnet: boolean; readyMainnet: boolean; liveRoutes: string[]; totalRoutes: number }> {
  const checks: Check[] = [];
  const add = (c: Check): void => { checks.push(c); };
  const path = opts.configPath ?? "watchtower.config.json";
  let file: { live?: LiveConfig; contractId?: string; rpcUrl?: string } = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(readFileSync(path, "utf8"));
      add({ area: "Config", name: path, level: "ok", detail: "found" });
    } catch (e) {
      add({ area: "Config", name: path, level: "fail", detail: `not valid JSON: ${(e as Error).message}` });
    }
  } else {
    add({ area: "Config", name: path, level: "warn", detail: "not found, using public defaults", fix: "copy config/watchtower.example.json to watchtower.config.json" });
  }
  const live: LiveConfig = { ...DEFAULT_LIVE, ...(file.live ?? {}), near: { ...DEFAULT_LIVE.near, ...(file.live?.near ?? {}) }, chains: { ...DEFAULT_LIVE.chains, ...(file.live?.chains ?? {}) } };

  const near = new NearRpc(live.near.rpcUrl);
  const tasks: Promise<void>[] = [];
  const probe = (area: string, name: string, fn: () => Promise<string>, fix?: string) =>
    tasks.push(withTimeout(fn()).then((detail) => add({ area, name, level: "ok", detail }), (e) => add({ area, name, level: "fail", detail: String((e as Error).message ?? e).slice(0, 140), fix })));

  probe("NEAR", "mainnet RPC", async () => { const h = await near.head(); return `block ${h.headHeight.toLocaleString("en-US")}, ${ago(h.headTimeMs)}`; }, "set live.near.rpcUrl to another NEAR RPC provider");
  probe("NEAR", "block indexer (neardata)", async () => `final block ${(await new NeardataIndexer(live.near.neardataUrl).lastFinalHeight()).toLocaleString("en-US")}`, "check live.near.neardataUrl");
  probe("NEAR", "intents.near", async () => { await near.view(live.near.intentsContract, "mt_batch_balance_of", { account_id: "intents.near", token_ids: ["nep141:wrap.near"] }); return "reachable"; });
  probe("Prices", "1Click token list", async () => {
    const tokens = await new OneClickClient(live.oneClickUrl).tokens();
    const ids = new Set(tokens.map((x) => x.assetId));
    const known = DEFAULT_ASSETS.filter((a) => a.nearTokenId);
    const found = known.filter((a) => ids.has(a.nearTokenId!)).length;
    return `${tokens.length} tokens, ${found} of ${known.length} Watchtower assets listed`;
  });
  for (const a of DEFAULT_ASSETS) {
    if (a.bridge === "native" || !a.nearTokenId?.startsWith("nep141:")) continue;
    const contract = file.live?.assets?.[a.key]?.nearContract ?? a.nearTokenId.slice("nep141:".length);
    probe("Bridge supply", a.key, async () => {
      const supply = await near.ftTotalSupply(contract);
      return `${(Number(supply / 10n ** BigInt(Math.max(0, a.decimals - 2))) / 100).toLocaleString("en-US")} ${a.symbol.toUpperCase()} credited on ${contract}`;
    }, "set live.assets[asset].nearContract to the bridge token contract");
  }
  for (const [id, c] of Object.entries(live.chains)) {
    const reader = c.kind === "esplora" ? new EsploraReader(id, c.url) : c.kind === "evm" ? new EvmReader(id, c.url) : new SolanaReader(c.url);
    probe("Home chains", id, async () => { const h = await reader.head(); return `height ${h.headHeight.toLocaleString("en-US")}, ${ago(h.headTimeMs)}`; }, `set live.chains.${id}.url to another ${c.kind} endpoint`);
  }

  // Custody addresses decide whether backing can be proven at all.
  const bridged = DEFAULT_ASSETS.filter((a) => a.bridge !== "native");
  const withCustody = new Set<string>();
  for (const a of bridged) {
    const cfg = file.live?.assets?.[a.key];
    const real = (cfg?.custody ?? []).filter((x) => x && !x.startsWith("<"));
    const hot = (cfg?.hotWallets ?? []).filter((x) => x && !x.startsWith("<"));
    if (real.length && (cfg as { partial?: unknown } | undefined)?.partial) add({ area: "Custody", name: a.key, level: "warn", detail: `partly verified: the treasury holds part of what users are owed, so routes with this asset never go green; red if the shortfall grows` });
    else if (real.length) {
      withCustody.add(a.key);
      add({ area: "Custody", name: a.key, level: "ok", detail: `${real.length} address${real.length === 1 ? "" : "es"} configured` });
    } else if (hot.length) add({ area: "Custody", name: a.key, level: "warn", detail: "hot wallet known, but it doesn't hold the whole supply: routes with this asset read unverified", fix: "npm run custody" });
    else add({ area: "Custody", name: a.key, level: "warn", detail: "not set up yet: routes with this asset read unverified", fix: "npm run custody" });
  }
  // A route can go green once every bridged asset on it has custody; native NEAR assets need none.
  const native = new Set(DEFAULT_ASSETS.filter((a) => a.bridge === "native").map((a) => a.key));
  const liveRoutes = DEFAULT_ROUTES.filter((r) => {
    const { src, dst } = parseRoute(r);
    return [src, dst].every((x) => native.has(x) || withCustody.has(x));
  });

  // The contract, when there is one.
  const contractId = opts.contractId ?? file.contractId;
  const network = opts.network ?? (contractId?.endsWith(".near") ? "mainnet" : "testnet");
  if (contractId) {
    const rpc = new NearRpc(upgradeNearRpc(file.rpcUrl ?? RPC[network]));
    tasks.push(withTimeout(rpc.view<{ quorum: number; watcher_count: number; route_count: number; paused: boolean; version: string }>(contractId, "get_config"))
      .then((c) => {
        add({ area: "Contract", name: `${contractId} (${network})`, level: "ok", detail: `v${c.version}, quorum ${c.quorum}, ${c.watcher_count} watchers, ${c.route_count} routes${c.paused ? ", PAUSED" : ""}` });
        if (c.watcher_count < 3) add({ area: "Contract", name: "watchers", level: "warn", detail: `${c.watcher_count} registered; 3 independent watchers are recommended`, fix: "npm run deploy registers three" });
        if (c.route_count === 0) add({ area: "Contract", name: "reports", level: "warn", detail: "no verdicts yet: every is_safe call returns false until watchers report", fix: "start the watchers (docs/MAINNET.md, step 4)" });
      }, (e) => add({ area: "Contract", name: `${contractId} (${network})`, level: "fail", detail: String((e as Error).message).slice(0, 140), fix: "deploy it with npm run deploy" })));
  } else {
    add({ area: "Contract", name: "contract id", level: "warn", detail: "none given", fix: "pass --contract watchtower.<you>.testnet after deploying" });
  }

  // The relayer pays gas for every report: show its balance so the real cost is visible over time.
  const relayer = opts.relayer ?? process.env.RELAYER_ACCOUNT_ID;
  if (relayer) {
    const net = relayer.endsWith(".near") ? "mainnet" : "testnet";
    tasks.push(withTimeout(jsonRpc<{ amount: string }>(RPC[net], "query", { request_type: "view_account", finality: "final", account_id: relayer }))
      .then((a) => {
        const near = Number(BigInt(a.amount) / 10n ** 20n) / 10_000;
        add({ area: "Relayer", name: `${relayer} (${net})`, level: near < 1 ? "warn" : "ok", detail: `${near.toLocaleString("en-US", { maximumFractionDigits: 4 })} NEAR available for gas`, fix: near < 1 ? "top it up; every report is a transaction" : undefined });
      }, (e) => add({ area: "Relayer", name: relayer, level: "fail", detail: String((e as Error).message).slice(0, 140) })));
  }

  const keys = [1, 2, 3].filter((i) => existsSync(`data/watcher-${i}.json`)).length;
  add({ area: "Watchers", name: "keys in data/", level: keys === 3 ? "ok" : "warn", detail: `${keys} of 3 watcher keys`, fix: keys === 3 ? undefined : "npm run deploy creates them" });

  await Promise.all(tasks);
  const order = ["Config", "NEAR", "Prices", "Bridge supply", "Home chains", "Custody", "Contract", "Relayer", "Watchers"];
  checks.sort((a, b) => order.indexOf(a.area) - order.indexOf(b.area));
  const failed = (area: string) => checks.some((c) => c.area === area && c.level === "fail");
  const readyTestnet = !failed("NEAR") && !failed("Prices") && !failed("Home chains");
  const readyMainnet = readyTestnet && liveRoutes.length > 0 && !failed("Bridge supply") && checks.some((c) => c.area === "Contract" && c.level === "ok") && keys === 3;
  return { checks, readyTestnet, readyMainnet, liveRoutes, totalRoutes: DEFAULT_ROUTES.length };
}

export function printDoctor(r: Awaited<ReturnType<typeof runDoctor>>, color: { green: (s: string) => string; red: (s: string) => string; yellow: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string }): void {
  let area = "";
  for (const c of r.checks) {
    if (c.area !== area) { area = c.area; console.log(`\n${color.bold(area)}`); }
    const mark = c.level === "ok" ? color.green("✓") : c.level === "warn" ? color.yellow("!") : color.red("✗");
    console.log(`  ${mark} ${c.name.padEnd(28)} ${c.detail}${c.fix ? color.dim(`  → ${c.fix}`) : ""}`);
  }
  console.log("");
  if (r.checks.filter((c) => c.area === "NEAR" || c.area === "Home chains").every((c) => c.level === "fail")) {
    console.log(color.yellow("Every network check failed. That usually means no internet access, a firewall or a VPN blocking it, not a problem with the services."));
  }
  console.log(`${r.readyTestnet ? color.green("✓") : color.red("✗")} Live data reachable: ${r.readyTestnet ? "yes, a watcher can run against real networks (publish to testnet first)" : "no, fix the ✗ lines above"}`);
  const n = r.liveRoutes.length;
  const which = n ? ` (${r.liveRoutes.join(", ")})` : "";
  console.log(`${r.readyMainnet ? color.green("✓") : color.red("✗")} Ready for mainnet: ${r.readyMainnet ? `yes. ${n} of ${r.totalRoutes} routes can go green${which}; the other ${r.totalRoutes - n} read unverified until their custody is set up` : n ? `not yet: fix the ✗ lines above. ${n} of ${r.totalRoutes} routes have custody: ${r.liveRoutes.join(", ")}` : "not yet: no route has custody set up for all its assets (npm run custody)"}`);
}
