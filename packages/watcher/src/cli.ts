#!/usr/bin/env node
/**
 * watchtower — command line for Intents Watchtower.
 *
 *   watchtower replay [scenario|all] [--json out.json] [--lang en|fr|es]
 *   watchtower simulate [--scenario id] [--minutes N] [--watchers 3] [--quorum 2]
 *   watchtower agent-demo
 *   watchtower run --config watchtower.config.json [--once] [--submit] [--watcher 1|2|3]
 *   watchtower relayer                 save the account that pays watchers' gas to data/relayer.json
 *   watchtower custody [--apply] [--only a,b] [--deep [n]]
 *                                      find where each bridge holds its coins, from what the watchers recorded;
 *                                      --deep traces up to n deposits (600) to measure coins not yet swept
 *   watchtower keygen
 *   watchtower vectors [--out test-vectors/attestation.json]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { Status } from "@watchtower/core";
import { DEFAULT_ASSETS, formatUsdCents, generateWatcherKey, toJson } from "@watchtower/core";
import { defaultConfig } from "@watchtower/engine";
import { explain, type Lang } from "@watchtower/explainer";
import { SCENARIOS, World, getScenario, runScenario } from "@watchtower/replay";
import { Watchtower, withWatchtower, RouteUnsafeError } from "@watchtower/sdk";
import { LiveCollector, NearRpc, fetchJson, httpStats, realAddresses, supplySource, type LiveConfig } from "@watchtower/collectors";
import { FileBlockCache } from "./blockcache.ts";
import { AlertManager, ConsoleSink } from "./alerts.ts";
import { LocalNetwork } from "./network.ts";
import { WatcherNode } from "./node.ts";
import { NearSubmitter } from "./submitter.ts";
import { applyCustody, findCustody, printCustody } from "./custody.ts";
import { findOrigin, printOrigin } from "./origin.ts";
import { DEFAULT_LIVE } from "./doctor.ts";

/** Printed by the custody finder, so its output shows which version produced it. */
const BUILD = "2026-11-10.3";
import { openPglite } from "@watchtower/store";
import { sendTelegram } from "@watchtower/bot";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name: string) => argv.includes(`--${name}`);

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const C = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = C(2), bold = C(1), red = C(31), green = C(32), yellow = C(33), gray = C(90), cyan = C(36);
const paint: Record<Status, (s: string) => string> = { green, amber: yellow, unknown: gray, red };
const dot = (s: Status) => paint[s]("●");
const tLabel = (t: number) => (t < 0 ? `T${t}m` : `T+${t}m`).padStart(6);

async function replay(): Promise<void> {
  const which = argv[1] && !argv[1].startsWith("--") ? argv[1] : "oct-2026-ghost-credit";
  const lang = (flag("lang", "en") as Lang) ?? "en";
  const list = which === "all" ? SCENARIOS : [getScenario(which)];
  const results = [];
  for (const s of list) {
    const t0 = performance.now();
    const r = runScenario(s);
    results.push(r);
    console.log(`\n${bold(s.title)}  ${dim(`(${s.id}${s.simulated ? ", simulation" : ""}, ${Math.round(performance.now() - t0)} ms)`)}`);
    console.log(dim(s.summary));
    console.log("");
    // Narrative markers + transitions, merged by minute.
    const lines: { m: number; text: string }[] = [];
    for (const f of r.frames) for (const m of f.markers) lines.push({ m: f.minute, text: `${cyan("▸")} ${m}` });
    const grouped = new Map<string, { m: number; t: number; to: Status; routes: string[]; reasons: string[] }>();
    for (const tr of r.transitions) {
      const key = `${tr.minute}|${tr.to}|${tr.reasons[0] ?? ""}`;
      const g = grouped.get(key) ?? { m: tr.minute, t: tr.t, to: tr.to, routes: [], reasons: tr.reasons };
      g.routes.push(tr.route);
      grouped.set(key, g);
    }
    for (const g of grouped.values()) lines.push({ m: g.m, text: `${dot(g.to)} ${paint[g.to](g.to.toUpperCase().padEnd(7))} ${g.routes.length > 1 ? `${g.routes.length} routes` : g.routes[0]}  ${dim(g.reasons.slice(0, 3).join(", "))}` });
    lines.push({ m: -1, text: `${dot("green")} ${green("GREEN  ")} all ${r.frames[0]!.routes.length} routes healthy ${dim("(except known thin books)")}` });
    for (const l of lines.sort((a, b) => a.m - b.m)) console.log(`  ${dim(tLabel(l.m < 0 ? -s.incidentAtMin : l.m - s.incidentAtMin))}  ${l.text}`);

    const sm = r.summary;
    console.log("");
    console.log(`  ${bold("First alert")}   ${sm.firstAlertT === null ? "none" : tLabel(sm.firstAlertT).trim()}    ${bold("First red")} ${sm.firstRedT === null ? "none" : tLabel(sm.firstRedT).trim()}    ${bold("Worst")} ${paint[sm.focusWorst](sm.focusWorst)}`);
    console.log(`  ${bold("Precision")}     ${sm.collateralRedMinutes === 0 ? green("0 red minutes on unrelated routes") : red(`${sm.collateralRedMinutes} red minutes on unrelated routes`)}    ${bold("Recovered")} ${sm.recovered ? green("yes") : yellow("no")}`);
    if (sm.attack) {
      const total = BigInt(sm.attack.withdrawnUsdCents);
      const after = BigInt(sm.attack.withdrawnAfterRedUsdCents);
      console.log(`  ${bold("Drain")}         ${formatUsdCents(BigInt(sm.attack.ghostCreditedUsdCents), { compact: true })} ghost-credited · ${formatUsdCents(total, { compact: true })} withdrawn · ${red(`${formatUsdCents(after, { compact: true })} (${(sm.attack.shareAfterRedPpm / 10_000).toFixed(1)}%) moved after Watchtower was red`)}`);
    }
    const worst = r.transitions.find((tr) => s.focusRoutes.includes(tr.route) && tr.to === sm.focusWorst);
    if (worst) {
      const e = await explain(worst.verdict, lang);
      console.log(`  ${bold("Alert")}         ${e.text}`);
    }
    if (s.simulated) console.log(dim(`  Simulation. ${s.basis.assumptions[0] ?? ""}`));
  }
  const out = flag("json");
  if (out) {
    writeFileSync(out, toJson(results.length === 1 ? results[0] : results, 2));
    console.log(dim(`\nwrote ${out}`));
  }
}

async function simulate(): Promise<void> {
  const scenario = flag("scenario") ? getScenario(flag("scenario")!) : undefined;
  const minutes = Number(flag("minutes", scenario ? String(scenario.durationMin) : "20"));
  const net = new LocalNetwork({ watchers: Number(flag("watchers", "3")), quorum: Number(flag("quorum", "2")) });
  const world = new World({ seed: scenario?.seed ?? "simulate", startMs: (scenario?.startMs ?? Date.now()) - (scenario?.incidentAtMin ?? 0) * 60_000 });
  const alerts = new AlertManager([new ConsoleSink()], { langs: ["en", "fr"] });
  console.log(bold(`${net.watchers.length} watchers · quorum ${net.mirror.quorum} · escalation ${net.mirror.escalationThreshold}`));
  for (let m = 0; m <= minutes; m++) {
    const due = scenario?.events.filter((e) => e.atMin === m) ?? [];
    const batch = world.tick(60_000, (w) => due.forEach((e) => e.apply(w)));
    for (const e of due) console.log(`${dim(`m${m}`)} ${cyan("▸")} ${e.label}`);
    const before = net.mirror.events.length;
    const results = await net.step(batch);
    for (const v of results[0]!.report.routes) await alerts.onVerdict(v, batch.asOfMs);
    for (const ev of net.mirror.events.slice(before)) {
      if (ev.event === "route_health_updated" && ev.data.from !== ev.data.to) {
        console.log(`${dim(`m${m}`)} ${dot(ev.data.to as Status)} on-chain ${String(ev.data.route_id)}: ${String(ev.data.from ?? "∅")} → ${bold(String(ev.data.to))} ${dim(`(${String(ev.data.signers)} signer${ev.data.signers === 1 ? "" : "s"}, ${String(ev.data.report_hash).slice(0, 10)}…)`)}`);
      }
      if (ev.event === "watcher_disagreement") console.log(`${dim(`m${m}`)} ${yellow("⚠")} watchers disagree on ${String(ev.data.route_id)}`);
    }
  }
  const wt = new Watchtower({ source: { view: async (m, a) => net.mirror.view(m, a) as never }, cacheMs: 0 });
  console.log(bold("\nis_safe() now:"));
  for (const r of net.watchers[0]!.engine.cfg.routes) {
    const c = await wt.check(r);
    console.log(`  ${dot(c.status ?? "unknown")} ${r.padEnd(28)} ${c.safe ? green("safe") : red("unsafe")} ${dim(c.verdict)}`);
  }
}

async function agentDemo(): Promise<void> {
  const s = getScenario("oct-2026-ghost-credit");
  const net = new LocalNetwork({});
  const world = new World({ seed: s.seed, startMs: s.startMs - s.incidentAtMin * 60_000 });
  for (let m = 0; m <= s.incidentAtMin + 6; m++) {
    const due = s.events.filter((e) => e.atMin === m);
    await net.step(world.tick(60_000, (w) => due.forEach((e) => e.apply(w))));
  }
  const wt = new Watchtower({ source: { view: async (m, a) => net.mirror.view(m, a) as never }, cacheMs: 0 });
  const swaps: string[] = [];
  const agent = {
    async swap(req: { route: string; amountUsd: number }) {
      swaps.push(req.route);
      return `swapped $${req.amountUsd} via ${req.route}`;
    },
  };
  const safeAgent = withWatchtower(agent, {
    client: wt,
    alternatives: (route) => (route.startsWith("usdt:bsc") ? ["usdc:ethereum->sol:solana", "eth:ethereum->usdc:near"] : []),
    withRoute: (args, route) => [{ ...(args[0] as object), route }],
    onDecision: (d) => console.log(`  ${d.check.safe ? green("✓") : red("✗")} ${d.requested} → ${d.check.verdict}${d.check.status ? ` (${d.check.status})` : ""}${d.used && d.used !== d.requested ? `, rerouted to ${bold(d.used)}` : ""}`),
  });
  console.log(bold("Agent wants to move $25,000 out of USDT on BSC, six minutes into the incident:"));
  console.log("  " + (await safeAgent.swap({ route: "usdt:bsc->usdc:near", amountUsd: 25_000 })));
  console.log(bold("\nSame agent, no alternatives offered:"));
  const strict = withWatchtower(agent, { client: wt });
  try {
    await strict.swap({ route: "near:near->usdt:bsc", amountUsd: 5_000 });
  } catch (e) {
    if (e instanceof RouteUnsafeError) console.log(`  ${red("blocked:")} ${e.message}`);
    else throw e;
  }
}

async function runLive(): Promise<void> {
  const path = flag("config", "watchtower.config.json")!;
  const file = JSON.parse(readFileSync(path, "utf8")) as { live: LiveConfig; contractId: string; rpcUrl: string };
  // --watcher N reads data/watcher-N.json (written by npm run deploy); otherwise the environment.
  const n = flag("watcher", undefined);
  const keyFile = n ? readKeyFile(`data/watcher-${n}.json`, "npm run deploy creates it") : undefined;
  const watcherId = keyFile?.account_id ?? process.env.WATCHER_ACCOUNT_ID;
  const secretKey = keyFile?.secret_key ?? process.env.WATCHER_SECRET_KEY;
  if (!watcherId || !secretKey) throw new Error("Pass --watcher 1 (reads data/watcher-1.json), or set WATCHER_ACCOUNT_ID and WATCHER_SECRET_KEY");
  const wid: string = watcherId;
  const cfg = defaultConfig();
  // Gas is paid by a relayer (environment, or data/relayer.json from `npm run relayer`), else by the watcher account itself.
  const relayerFile = existsSync("data/relayer.json") ? readKeyFile("data/relayer.json", "npm run relayer") : undefined;
  const payer = process.env.RELAYER_ACCOUNT_ID ?? relayerFile?.account_id ?? watcherId;
  const payerKey = process.env.RELAYER_SECRET_KEY ?? relayerFile?.secret_key ?? secretKey;
  if (has("submit") && payer === watcherId) console.log(yellow(`No relayer set: ${watcherId} pays its own gas, so it must exist on-chain. Run npm run relayer to use your account instead.`));
  const submitter = has("submit") ? new NearSubmitter({ rpcUrl: file.rpcUrl, contractId: file.contractId, accountId: payer, privateKey: payerKey }) : undefined;
  console.log(dim(`${watcherId}${submitter ? `, gas paid by ${payer}` : ", trial run: nothing is sent"}`));
  // Optional persistence: PGlite directory (zero setup). For managed Postgres, pass a pg.Pool to PgStore.
  const store = process.env.WATCHTOWER_PGLITE_DIR ? await openPglite(process.env.WATCHTOWER_PGLITE_DIR) : undefined;
  const saved = (await store?.loadState(watcherId)) ?? undefined;
  if (saved) console.log(dim(`resuming engine state for ${watcherId}`));
  // Unchanged verdicts are re-confirmed every N minutes so the contract never goes stale. Each
  // confirmation is a transaction, so on mainnet a longer interval saves gas; keep it below the
  // contract's default_max_age_sec (npm run deploy sets 15 min on mainnet, so 10 is the default there).
  const refreshEpochs = Number(process.env.WATCHTOWER_REFRESH_MINUTES ?? (file.rpcUrl?.includes("mainnet") ? 10 : 4));
  const node = new WatcherNode({ watcherId, secretKey, contractId: file.contractId, config: cfg, submitter, state: saved, refreshEpochs });
  if (submitter) console.log(dim(`submitting to ${file.contractId}; unchanged routes re-confirmed every ${refreshEpochs} min, changes immediately`));
  // FASTNEAR_API_KEY=off runs on the free public endpoints even if the config holds a key (no credits spent).
  if (process.env.FASTNEAR_API_KEY === "off") { if (file.live.near) delete (file.live.near as { apiKey?: string }).apiKey; }
  else if (process.env.FASTNEAR_API_KEY) file.live.near = { ...file.live.near, apiKey: process.env.FASTNEAR_API_KEY };
  // --data-mb N: how much NEAR block data a round may download (default 1 MB, about 1.4 GB a day).
  const dataMb = Number(flag("data-mb", process.env.WATCHTOWER_DATA_MB ?? "")) || file.live.indexBudgetMb;
  if (dataMb) file.live.indexBudgetMb = dataMb;
  const collector = new LiveCollector(file.live);
  // Watchers on the same machine share NEAR block downloads through this folder.
  const blockCache = new FileBlockCache(process.env.WATCHTOWER_BLOCK_CACHE ?? "data/near-cache");
  collector.setBlockCache(blockCache);
  let lastBytes = httpStats.bytes;
  let rounds = 0;
  const alerts = new AlertManager([new ConsoleSink()], { langs: ["en"], ai: process.env.NEAR_AI_API_KEY ? { apiKey: process.env.NEAR_AI_API_KEY } : undefined });
  // Every bridge deposit and withdrawal seen on NEAR, for `npm run custody` to trace to the bridge's wallets.
  const eventsFile = `data/bridge-events-${n ?? wid.split(".")[0]}.jsonl`;
  const once = has("once");
  for (;;) {
    const epochStart = Math.floor(Date.now() / cfg.stepMs) * cfg.stepMs;
    try {
      await liveRound(epochStart);
    } catch (e) {
      // A watcher runs for days: one bad round (connection drop, database hiccup) must not stop it.
      if (once) throw e;
      console.log(red(`${new Date(epochStart).toISOString()} round failed: ${String((e as Error)?.message ?? e).slice(0, 200)}; trying again next minute`));
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, Math.max(1000, epochStart + cfg.stepMs + 5_000 - Date.now())));
  }

  async function liveRound(epochStart: number): Promise<void> {
    const batch = await collector.collect(epochStart);
    const events = [
      ...(batch.credits ?? []).map((c) => ({ kind: "deposit", asset: c.asset, amount: c.amount.toString(), account: c.account, nearTx: c.nearTx, atMs: c.atMs, sourceTxRef: c.sourceTxRef })),
      ...(batch.withdrawals ?? []).map((w) => ({ kind: "withdrawal", asset: w.asset, amount: w.amount.toString(), account: w.account, nearTx: w.nearTx, atMs: w.atMs, destAddress: w.destAddress })),
    ];
    if (events.length) {
      mkdirSync("data", { recursive: true });
      appendFileSync(eventsFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    const res = await node.step(batch);
    if (store) {
      await store.saveBatch(batch);
      await store.saveReport(res.report);
      await store.saveState(wid, node.engine.snapshot(), res.report.asOfMs, res.report.inputsDigest);
      for (const a of res.attestations) await store.saveAttestation({ route: a.payload.route_id, epoch: a.payload.epoch, reportHash: a.payload.report_hash, watcherId: wid, signature: a.attestation.signature, atMs: epochStart });
    }
    for (const v of res.report.routes) {
      const alert = await alerts.onVerdict(v, epochStart);
      if (alert && store) await store.saveAlert({ route: alert.route, severity: alert.to, fromStatus: alert.from, reasons: alert.reasons, explanation: alert.texts.en ?? "", evidenceLinks: alert.evidence, reportHash: alert.reportHash, sentAtMs: epochStart });
      if (alert && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) await sendTelegram(alert as never, { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, explorerTxUrl: "https://nearblocks.io/txns/", statusPageUrl: process.env.STATUS_PAGE_URL }).catch((e) => console.log(red(`telegram: ${String(e)}`)));
    }
    console.log(`${new Date(epochStart).toISOString()} epoch ${res.report.epoch}: ${res.report.routes.map((r) => `${dot(r.status)} ${r.route}`).join("  ")}`);
    // The same in words, since colours don't survive copy and paste.
    const count = (st: Status) => res.report.routes.filter((r) => r.status === st).length;
    const why = new Map<string, number>();
    for (const r of res.report.routes) if (r.status !== "green") for (const code of new Set(r.reasons.map((x) => x.split(":")[0]!))) why.set(code, (why.get(code) ?? 0) + 1);
    const top = [...why].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, k]) => `${c} (${k})`).join(", ");
    console.log(`  ${count("green")} green, ${count("amber")} amber, ${count("red")} red, ${count("unknown")} unverified${top ? `. Main reasons: ${top}` : ""}`);
    // Group identical errors: a refusing RPC is one problem, not twelve.
    const failures = new Map<string, string[]>();
    for (const a of res.attestations) if (a.error) failures.set(a.error, [...(failures.get(a.error) ?? []), a.payload.route_id]);
    for (const [err, routes] of failures) console.log(red(`  couldn't send ${routes.length === 1 ? routes[0] : `${routes.length} verdicts`}: ${err.replace(/\s+/g, " ").slice(0, 220)}${failures.size ? "; retrying next minute" : ""}`));
    const mb = (httpStats.bytes - lastBytes) / 1e6;
    lastBytes = httpStats.bytes;
    const how = collector.indexedBlocks === 0 ? "no NEAR blocks read" : `${collector.indexedBlocks} NEAR blocks${collector.indexedShards ? `, shards ${collector.indexedShards.join(", ")} only` : ", whole blocks (shard layout unavailable)"}`;
    const lag = [collector.behindBlocks > 30 ? `${collector.behindBlocks} blocks behind` : "", collector.indexStop ? `stopped reading: ${collector.indexStop}` : "", collector.skippedBlocks ? `skipped ${collector.skippedBlocks} blocks to catch up` : ""].filter(Boolean).join("; ");
    console.log(dim(`  downloaded ${mb.toFixed(1)} MB this round (${how})${lag ? `; ${lag}` : ""}`));
    if (rounds++ % 5 === 0) blockCache.prune();
    if (events.length) console.log(dim(`  bridge activity: ${events.filter((e) => e.kind === "deposit").length} deposits, ${events.filter((e) => e.kind === "withdrawal").length} withdrawals (saved for npm run custody)`));
    const sent = res.attestations.filter((a) => a.outcome).length;
    if (submitter && sent) console.log(dim(`  sent ${sent} verdict${sent === 1 ? "" : "s"} to ${file.contractId}`));
  }
}

function readKeyFile(path: string, hint: string): { account_id: string; secret_key: string } {
  if (!existsSync(path)) throw new Error(`${path} not found (${hint})`);
  const k = JSON.parse(readFileSync(path, "utf8")) as { account_id?: string; secret_key?: string };
  if (!k.account_id || !k.secret_key) throw new Error(`${path} needs account_id and secret_key`);
  return { account_id: k.account_id, secret_key: k.secret_key };
}

/** Save the account that pays watchers' gas, so each watcher window needs no secrets typed in. */
async function saveRelayer(): Promise<void> {
  console.log("Watchers sign verdicts with their own keys; one NEAR account pays the gas for sending them.");
  console.log(dim("Get its private key with: near account export-account <account> using-private-key network-config testnet\n"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const account = (await rl.question("Account that pays the gas (for example you.testnet): ")).trim();
  const key = (await rl.question("Its private key (starts with ed25519:): ")).trim();
  rl.close();
  if (!/^[a-z0-9._-]+\.(testnet|near)$/.test(account)) throw new Error(`"${account}" doesn't look like a NEAR account name`);
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(key)) throw new Error("That doesn't look like an ed25519 private key: copy the whole value near-cli prints after 'private key', including ed25519:");
  mkdirSync("data", { recursive: true });
  writeFileSync("data/relayer.json", JSON.stringify({ account_id: account, secret_key: key }, null, 2));
  console.log(green(`✓ Saved data/relayer.json. Keep it secret: anyone with it can spend from ${account}. data/ is never committed.`));
}

async function main(): Promise<void> {
  switch (cmd) {
    case "replay": return replay();
    case "simulate": return simulate();
    case "agent-demo": return agentDemo();
    case "run": return runLive();
    case "relayer": return saveRelayer();
    case "custody": {
      console.log(bold("Custody finder") + dim(`  (build ${BUILD}; read-only unless --apply: traces the bridge transactions your watchers recorded)`));
      const only = flag("only", undefined)?.split(",").map((x) => x.trim()).filter(Boolean);
      // --deep [n]: trace up to n deposits (600 by default) to their deposit addresses and measure what's not yet swept.
      const deepArg = flag("deep", undefined);
      const deep = has("deep") ? (deepArg && /^\d+$/.test(deepArg) ? Number(deepArg) : 600) : undefined;
      if (deep) console.log(dim(`  deep scan: up to ${deep} deposits per asset; this takes several minutes`));
      // --history n: read NEAR history back n deposits and the hot wallets 1,000 transactions back,
      // without tracing each deposit: enough to see whether a gap is old or growing.
      const historyArg = flag("history", undefined);
      const historyDepth = has("history") ? (historyArg && /^\d+$/.test(historyArg) ? Number(historyArg) : 1200) : undefined;
      // --holders: NEAR-only. Who holds a bridged token: the bridge's own accounts (directly and
      // inside the intents ledger, owed to no user) and the largest holders, from FastNEAR.
      if (has("holders")) {
        const path = flag("config", undefined) ?? "watchtower.config.json";
        const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { live?: Partial<LiveConfig> }) : {};
        const rpc = new NearRpc(file.live?.near?.rpcUrl ?? DEFAULT_LIVE.near.rpcUrl);
        const intents = file.live?.near?.intentsContract ?? "intents.near";
        for (const key of only?.length ? only : ["btc:bitcoin", "ltc:litecoin"]) {
          const a = DEFAULT_ASSETS.find((x) => x.key === key);
          const cfg = file.live?.assets?.[key];
          const contract = cfg?.nearContract ?? (a?.nearTokenId ? supplySource(a.nearTokenId)?.nearContract : a?.bridge === "poa" ? `${a.symbol}.omft.near` : undefined);
          if (!a || !contract || cfg?.mtTokenId) { console.log(yellow(`  ${key}: not a NEP-141 bridged token; skipped`)); continue; }
          const sym = a.symbol.toUpperCase();
          const show = (v: bigint) => `${(Number(v / 10n ** BigInt(Math.max(0, a.decimals - 4))) / 10_000).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${sym}`;
          try {
            const supply = await rpc.ftTotalSupply(contract);
            const accounts = [...new Set([contract, "omft.near", ...(cfg?.issuerAccounts ?? [])])];
            console.log(bold(`\n${key}  ${show(supply)} on NEAR (${contract})`));
            let held = 0n;
            for (const acc of accounts) {
              const direct = BigInt(await rpc.view<string>(contract, "ft_balance_of", { account_id: acc }));
              let inside: bigint | undefined;
              try { inside = BigInt(await rpc.view<string>(intents, "mt_balance_of", { account_id: acc, token_id: `nep141:${contract}` })); } catch { inside = undefined; }
              held += direct + (inside ?? 0n);
              console.log(`  bridge account ${acc.padEnd(22)} ${show(direct)} directly, ${inside === undefined ? "? (unreadable)" : show(inside)} inside ${intents}`);
            }
            console.log(`  owed to users: ${show(supply - held)} (supply minus the bridge's own accounts)`);
            try {
              const top = await fetchJson<unknown>(`https://api.fastnear.com/v1/ft/${contract}/top`, {}, { timeoutMs: 15_000, retries: 1 });
              const list = (Array.isArray(top) ? top : Object.values(top as Record<string, unknown>).find(Array.isArray) ?? []) as { account_id?: string; balance?: string }[];
              console.log(dim(`  largest holders (FastNEAR):`));
              for (const h of list.slice(0, 10)) if (h.account_id && h.balance) console.log(`    ${h.account_id.padEnd(40)} ${show(BigInt(h.balance))}${h.account_id === intents ? dim("  the intents ledger: users' balances") : ""}`);
            } catch (e) {
              console.log(dim(`  largest holders: FastNEAR didn't answer (${(e as Error).message.slice(0, 80)})`));
            }
          } catch (e) {
            console.log(yellow(`  ${key}: ${(e as Error).message}`));
          }
        }
        break;
      }
      // --fees: could miner fees explain a shortfall? Adds up what the treasury's own transactions
      // paid to miners over its whole history (saved as it goes; run again to continue).
      if (has("fees")) {
        const path = flag("config", undefined) ?? "watchtower.config.json";
        const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { live?: Partial<LiveConfig> }) : {};
        const chains = { ...DEFAULT_LIVE.chains, ...(file.live?.chains ?? {}) };
        const { syncFees } = await import("./origin.ts");
        for (const key of only?.length ? only : ["btc:bitcoin", "ltc:litecoin"]) {
          const a = DEFAULT_ASSETS.find((x) => x.key === key);
          const cfg = file.live?.assets?.[key];
          const treasury = flag("treasury", undefined) ?? realAddresses(cfg?.hotWallets ?? cfg?.custody ?? [])[0];
          const chain = a ? chains[a.chain] : undefined;
          if (!a || !treasury || chain?.kind !== "esplora") { console.log(yellow(`  ${key}: needs a Bitcoin-like asset with its treasury saved (or pass --treasury <address>)`)); continue; }
          const sym = a.symbol.toUpperCase();
          const show = (v: bigint) => `${(Number(v / 10n ** BigInt(Math.max(0, a.decimals - 6))) / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${sym}`;
          try {
            const t = await syncFees(chain.url, treasury, "data", 2000, (s) => console.log(dim(`  … ${s}`)));
            const gap = cfg?.partial?.baselineGap ? BigInt(cfg.partial.baselineGap) : undefined;
            console.log(bold(`\n${key}  treasury ${treasury}`));
            console.log(`  ${t.done ? "whole history read" : yellow("history not finished: run again to continue")}${t.oldestMs ? `, back to ${new Date(t.oldestMs).toISOString().slice(0, 10)}` : ""}`);
            console.log(`  miner fees paid by the treasury's own payments: ${show(BigInt(t.spendFees))} over ${t.spendTxs.toLocaleString("en-US")} transactions`);
            console.log(`  miner fees on transactions paying into it:      ${show(BigInt(t.inFees))} over ${t.inTxs.toLocaleString("en-US")} transactions ${dim("(sweeps of deposits, and any other sender: an upper limit)")}`);
            if (gap !== undefined) {
              const all = BigInt(t.spendFees) + BigInt(t.inFees);
              console.log(`  usual shortfall: ${show(gap)}. Fees are ${all * 100n >= gap * 80n ? green("large enough to explain it") : all * 5n >= gap ? yellow("part of it at most") : "far too small to explain it"}.`);
            }
          } catch (e) {
            console.log(yellow(`  ${key}: stopped: ${(e as Error).message}`));
            console.log(dim(`  what was read is saved in the data folder; run the same command again later to continue`));
          }
        }
        break;
      }
      // --origin: when and through which transaction a shortfall appeared. It reads the treasury
      // saved in the config and NEAR's archive, and skips the finder's own explorer lookups,
      // which only use up a free explorer's rate limit.
      if (has("origin")) {
        const path = flag("config", undefined) ?? "watchtower.config.json";
        const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { live?: Partial<LiveConfig> }) : {};
        const chains = { ...DEFAULT_LIVE.chains, ...(file.live?.chains ?? {}) };
        const rpc = new NearRpc(file.live?.near?.rpcUrl ?? DEFAULT_LIVE.near.rpcUrl);
        for (const key of only?.length ? only : ["btc:bitcoin"]) {
          const a = DEFAULT_ASSETS.find((x) => x.key === key);
          const cfg = file.live?.assets?.[key];
          const contract = cfg?.nearContract ?? (a?.nearTokenId ? supplySource(a.nearTokenId)?.nearContract : undefined);
          const treasury = flag("treasury", undefined) ?? realAddresses(cfg?.hotWallets ?? [])[0];
          const chain = a ? chains[a.chain] : undefined;
          if (!a || !contract || !treasury || chain?.kind !== "esplora") {
            console.log(yellow(`  ${key}: the origin search needs a Bitcoin-like asset with its treasury saved (run npm run custody:apply once, or pass --treasury <address>)`));
            continue;
          }
          try {
            const issuers = cfg?.issuerAccounts ?? (contract.endsWith(".omft.near") ? [contract, "omft.near"] : []);
            const supply = await rpc.ftTotalSupply(contract);
            let held = 0n;
            for (const acc of issuers) held += BigInt(await rpc.view<string>(contract, "ft_balance_of", { account_id: acc }));
            const sym = a.symbol.toUpperCase();
            const show = (v: bigint) => `${(Number(v / 10n ** BigInt(Math.max(0, a.decimals - 4))) / 10_000).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${sym}`;
            console.log(`  ${key}: ${show(supply)} credited on NEAR, ${show(held)} held by the bridge's own accounts (${issuers.join(", ")}): ${show(supply - held)} owed to users; treasury ${treasury}`);
            const r = await findOrigin({ asset: key, decimals: a.decimals, contract, issuerAccounts: issuers, owedNow: supply - held, treasury, esploraUrl: chain.url, neardataUrl: file.live?.near?.neardataUrl, cacheDir: "data", log: (s) => console.log(dim(`  … ${s}`)) });
            printOrigin(r, { green, yellow, dim, bold });
          } catch (e) {
            console.log(yellow(`  ${key}: origin search stopped: ${(e as Error).message}`));
            console.log(dim(`  what was read is saved in the data folder; run the same command again later to continue`));
          }
        }
        break;
      }
      const found = await findCustody({ configPath: flag("config", undefined), only, deep, historyDepth, log: (s) => console.log(dim(`  … ${s}`)) });
      printCustody(found, { green, yellow, dim, bold });
      if (has("apply")) {
        const changed = applyCustody(found, flag("config", "watchtower.config.json"), { partial: has("partial") });
        console.log(changed.length ? green(`\nUpdated watchtower.config.json (old copy in watchtower.config.json.bak):\n  ${changed.join("\n  ")}\nRestart the watchers to use it.`) : dim("\nNothing to write yet."));
      } else console.log(dim("\nRun npm run custody:apply to write hot wallets (and complete custody lists) into watchtower.config.json."));
      return;
    }
    case "doctor": {
      const { runDoctor, printDoctor } = await import("./doctor.ts");
      console.log(bold("Intents Watchtower readiness check") + dim("  (read-only: nothing is signed or sent)"));
      const r = await runDoctor({ configPath: flag("config", undefined), contractId: flag("contract", undefined), network: flag("network", undefined) as "testnet" | "mainnet" | undefined, relayer: flag("relayer", undefined) ?? (existsSync("data/relayer.json") ? readKeyFile("data/relayer.json", "").account_id : undefined) });
      printDoctor(r, { green, red, yellow, dim, bold });
      return;
    }
    case "keygen": {
      const k = generateWatcherKey();
      console.log(JSON.stringify({ public_key: k.publicKey, secret_key: k.secretKey }, null, 2));
      console.log(dim("Register with: near contract call-function as-transaction <contract> add_watcher json-args '{\"account_id\":\"<you>\",\"public_key\":\"" + k.publicKey + "\"}' ..."));
      return;
    }
    case "vectors": {
      await import("../../../scripts/gen-vectors.ts");
      return;
    }
    default:
      console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 11).join("\n").replace(/^ \* ?/gm, ""));
  }
}

main().catch((e) => {
  console.error(red(String(e instanceof Error ? e.stack ?? e.message : e)));
  process.exit(1);
});
