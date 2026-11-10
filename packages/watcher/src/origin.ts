/**
 * Origin search: when, and through which transaction, a bridge's shortfall appeared.
 *
 * The shortfall at any moment is what NEAR had credited (the token's total supply, minus what
 * the bridge's own accounts held) minus what the treasury held. NEAR keeps every past block, so
 * the supply on any date is one archival query; the treasury's balance on any date comes from its
 * complete history. Sampling the shortfall over the treasury's life finds the stretch where it
 * changed; halving that stretch finds the hours; inside those hours every block where the supply
 * moved names its transaction, its account and, for a deposit, the Bitcoin transaction behind it.
 *
 * A deposit is credited on NEAR before its coins are swept into the treasury, and a withdrawal
 * is burned before it is paid, so a single instant can sit inside one of those gaps. Every
 * reading here is therefore "settled": the median of three readings an hour apart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchJson, jsonRpc, NearRpc, type HttpOptions } from "@watchtower/collectors";
import { depositRecipient, esploraGet, hotFlows, outcomesOf, units, type EsploraTx } from "./custody.ts";
import { parseEventLog } from "@watchtower/collectors";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A missing block or account: no point asking again. */
const isMissing = (e: unknown) => /UNKNOWN_BLOCK|DB Not Found|not found|garbage collected|does not exist|CodeDoesNotExist|UNKNOWN_ACCOUNT|MethodNotFound/i.test(String((e as Error)?.message ?? e));

/**
 * Retry with growing waits (2 s doubling, at most a minute): free endpoints answer "too many
 * requests" or drop connections under load, and a throttled request is not a missing answer.
 */
async function retrying<T>(fn: () => Promise<T>, tries = 7, maxWaitMs = 60_000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (isMissing(e) || i >= tries - 1) throw e;
      await sleep(Math.min(maxWaitMs, 2_000 * 2 ** i));
    }
  }
}

export interface SupplyEvent {
  atMs: number;
  /** + for a mint, − for a burn, in base units. */
  delta: bigint;
  kind: "mint" | "burn";
  owner: string;
  memo?: string;
  nearTx: string;
  height: number;
}

/** What the search needs from NEAR. The real one asks an archival RPC and neardata; tests pass a fake. */
export interface NearHistory {
  /** The block at or just after `atMs`. */
  blockAt(atMs: number): Promise<{ height: number; atMs: number }>;
  /** Credited supply at a height: total supply minus the bridge's own accounts. */
  creditedAt(height: number): Promise<bigint>;
  /** Raw total supply at a height (to find the blocks where it moved). */
  supplyAt(height: number): Promise<bigint>;
  /** Mints and burns the token contract logged in one block. */
  eventsIn(height: number): Promise<SupplyEvent[]>;
}

/** Free archival endpoints, tried in turn: when one says "too many requests", the next is asked. */
export const ARCHIVAL_RPCS = ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"];

export function archivalNear(opts: { contract: string; issuerAccounts: string[]; rpcUrls?: string[]; neardataUrl?: string; http?: HttpOptions; cacheFile?: string; intervalMs?: number; log?: (s: string) => void }): NearHistory & { flush(): void } {
  const urls = opts.rpcUrls?.length ? opts.rpcUrls : ARCHIVAL_RPCS;
  const neardata = (opts.neardataUrl ?? "https://mainnet.neardata.xyz/v0").replace(/\/+$/, "");
  const key = process.env.FASTNEAR_API_KEY;
  const http: HttpOptions = { timeoutMs: 20_000, retries: 0, ...(opts.http ?? {}) };
  // With a key, FastNEAR allows far more; without one, about a question a second stays under free limits.
  const interval = opts.intervalMs ?? (key ? 100 : 1_000);
  // Answers kept between runs: a block's time and a view at a height never change.
  type Cache = { times: Record<string, number>; views: Record<string, string> };
  const cache: Cache = opts.cacheFile && existsSync(opts.cacheFile) ? JSON.parse(readFileSync(opts.cacheFile, "utf8")) : { times: {}, views: {} };
  let unsaved = 0;
  const flush = () => { if (opts.cacheFile && unsaved) { writeFileSync(opts.cacheFile, JSON.stringify(cache)); unsaved = 0; } };
  const remember = () => { if (++unsaved >= 20) flush(); };
  let current = 0;
  let lastCall = 0;
  /** One JSON-RPC call: paced, rotating endpoints on refusals, waiting longer each round. */
  const call = async <T,>(method: string, params: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + interval - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const url = urls[current % urls.length]!;
      try {
        const h = key && url.includes("fastnear") ? { ...http, headers: { authorization: `Bearer ${key}` } } : http;
        return await jsonRpc<T>(url, method, params, h);
      } catch (e) {
        if (isMissing(e)) throw e;
        if (attempt >= 3 * urls.length + 6) throw new Error(`NEAR's archives stopped answering: ${String((e as Error).message).slice(0, 160)}`);
        current++; // ask the next archive
        if (current % urls.length === 0) await sleep(Math.min(300_000, 5_000 * 2 ** Math.floor(attempt / urls.length)));
      }
    }
  };
  const blockTime = async (h: number): Promise<{ height: number; atMs: number }> => {
    for (let k = 0; k < 20; k++) {
      const hk = h + k;
      if (cache.times[hk] !== undefined) return { height: hk, atMs: cache.times[hk]! };
      try {
        const b = await call<{ header: { height: number; timestamp_nanosec: string } }>("block", { block_id: hk });
        const at = Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n);
        cache.times[b.header.height] = at;
        remember();
        return { height: b.header.height, atMs: at };
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
    }
    throw new Error(`no block found near height ${h}`);
  };
  const view = async (h: number, contract: string, method: string, args: Record<string, unknown>): Promise<bigint> => {
    const k = `${h}|${contract}|${method}|${JSON.stringify(args)}`;
    if (cache.views[k] !== undefined) return BigInt(cache.views[k]!);
    let v: bigint;
    try {
      const r = await call<{ result: number[] }>("query", { request_type: "call_function", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), block_id: h });
      v = BigInt(JSON.parse(Buffer.from(r.result).toString("utf8")) as string);
    } catch (e) {
      // Before the contract or account existed: nothing. A missing block is not a zero supply.
      if (!/does not exist|CodeDoesNotExist|UNKNOWN_ACCOUNT|AccountDoesNotExist|MethodNotFound/i.test(String((e as Error).message))) throw e;
      v = 0n;
    }
    cache.views[k] = v.toString();
    remember();
    return v;
  };
  let head: { height: number; atMs: number } | undefined;
  /** The known block nearest a time, to start the search from. */
  const nearest = (atMs: number) => {
    let best: { height: number; atMs: number } | undefined;
    for (const [h, t] of Object.entries(cache.times)) if (!best || Math.abs(t - atMs) < Math.abs(best.atMs - atMs)) best = { height: Number(h), atMs: t };
    return best;
  };
  return {
    flush,
    async blockAt(atMs) {
      if (!head) {
        const b = await call<{ header: { height: number; timestamp_nanosec: string } }>("block", { finality: "final" });
        head = { height: b.header.height, atMs: Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n) };
      }
      if (atMs >= head.atMs) return head;
      // Secant steps on (height, time), from the nearest block already known. Five minutes is
      // close enough: every reading is settled over two hours anyway.
      let a = head;
      const n = nearest(atMs);
      let b = n && Math.abs(n.atMs - atMs) < Math.abs(head.atMs - atMs) ? n : await blockTime(Math.max(1, Math.round(head.height - (head.atMs - atMs) / 600)));
      for (let i = 0; i < 12 && Math.abs(b.atMs - atMs) > 300_000; i++) {
        const rate = (a.atMs - b.atMs) / Math.max(1, a.height - b.height) || 600;
        const guess = Math.max(1, Math.round(b.height + (atMs - b.atMs) / (rate > 0 ? rate : 600)));
        a = b;
        b = await blockTime(guess);
      }
      return b;
    },
    async supplyAt(h) {
      return view(h, opts.contract, "ft_total_supply", {});
    },
    async creditedAt(h) {
      let held = 0n;
      for (const acc of opts.issuerAccounts) held += await view(h, opts.contract, "ft_balance_of", { account_id: acc });
      return (await view(h, opts.contract, "ft_total_supply", {})) - held;
    },
    async eventsIn(h) {
      const block = await retrying(() => fetchJson<{ block?: { header?: { timestamp_nanosec?: string } }; shards?: { receipt_execution_outcomes?: { tx_hash?: string; execution_outcome?: { outcome?: { executor_id?: string; logs?: string[] } } }[] }[] }>(`${neardata}/block/${h}`, {}, key ? { ...http, headers: { authorization: `Bearer ${key}` } } : http), 8, 120_000);
      const at = Number(BigInt(block.block?.header?.timestamp_nanosec ?? "0") / 1_000_000n);
      const out: SupplyEvent[] = [];
      for (const s of block.shards ?? []) for (const r of s.receipt_execution_outcomes ?? []) {
        const o = r.execution_outcome?.outcome;
        if (o?.executor_id !== opts.contract) continue;
        for (const l of o.logs ?? []) {
          const ev = parseEventLog(l);
          if (!ev || (ev.event !== "ft_mint" && ev.event !== "ft_burn")) continue;
          for (const d of ev.data as { owner_id?: string; amount?: string; memo?: string }[]) {
            if (!d.amount) continue;
            out.push({ atMs: at, height: h, delta: ev.event === "ft_mint" ? BigInt(d.amount) : -BigInt(d.amount), kind: ev.event === "ft_mint" ? "mint" : "burn", owner: d.owner_id ?? "?", memo: d.memo, nearTx: r.tx_hash ?? "?" });
          }
        }
      }
      return out;
    },
  };
}

export interface TreasuryMove { txid: string; atMs: number; delta: bigint }

/** A treasury's balance at any time from its history: now minus every move after that time. */
export function treasuryAt(moves: TreasuryMove[], balanceNow: bigint): (atMs: number) => bigint {
  const sorted = [...moves].sort((a, b) => b.atMs - a.atMs); // newest first
  return (atMs) => {
    let b = balanceNow;
    for (const m of sorted) {
      if (m.atMs <= atMs) break;
      b -= m.delta;
    }
    return b;
  };
}

export interface ShortfallStep {
  fromMs: number;
  toMs: number;
  before: bigint;
  after: bigint;
  /** Every block in the window where the supply moved, with what moved it. */
  supplyChanges: SupplyEvent[];
  /** Treasury transactions in the window. */
  treasuryTxs: { txid: string; atMs: number; delta: bigint }[];
}

export interface OriginReport {
  asset: string;
  decimals: number;
  treasury: string;
  /** The treasury's flows add up to its balance now: its whole history was read. */
  treasuryComplete: boolean;
  treasuryFirstMs?: number;
  treasuryTxs: number;
  startMs: number;
  overview: { atMs: number; gap: bigint }[];
  steps: ShortfallStep[];
  /** For each deposit in a step: where its coins went and what that address holds now. */
  deposits: { nearTx: string; sourceTx: string; amount: bigint; address?: string; balanceNow?: bigint }[];
}

/**
 * Find where the settled shortfall changed between `startMs` and `nowMs`: sample it, halve each
 * stretch that moved down to `resolutionMs`, then list every supply change inside.
 */
export async function locateShortfall(o: {
  near: NearHistory; hotAt: (atMs: number) => bigint; hotTxs: { txid: string; atMs: number; delta: bigint }[];
  startMs: number; nowMs: number; threshold: bigint; samples?: number; resolutionMs?: number; maxSteps?: number; log?: (s: string) => void;
}): Promise<{ overview: { atMs: number; gap: bigint }[]; steps: ShortfallStep[] }> {
  const at = async (t: number) => {
    const b = await o.near.blockAt(t);
    return { ...b, gap: (await o.near.creditedAt(b.height)) - o.hotAt(b.atMs) };
  };
  const settled = async (t: number) => {
    const ts = [t, t + HOUR, t + 2 * HOUR].map((x) => Math.min(x, o.nowMs - 60_000));
    const g = (await Promise.all(ts.map(at))).map((x) => x.gap).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return g[1]!;
  };
  const n = o.samples ?? 40;
  const overview: { atMs: number; gap: bigint }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = Math.round(o.startMs + ((o.nowMs - 2 * HOUR - o.startMs) * i) / n);
    overview.push({ atMs: t, gap: await settled(t) });
    if (i % 10 === 9) o.log?.(`sampled ${i + 1} of ${n + 1} dates`);
  }
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const moves = overview.slice(1).map((p, i) => ({ a: overview[i]!, b: p, size: abs(p.gap - overview[i]!.gap) })).filter((m) => m.size >= o.threshold);
  moves.sort((x, y) => (y.size > x.size ? 1 : -1));
  const steps: ShortfallStep[] = [];
  for (const m of moves.slice(0, o.maxSteps ?? 4)) {
    let lo = m.a;
    let hi = m.b;
    while (hi.atMs - lo.atMs > (o.resolutionMs ?? 3 * HOUR)) {
      const mid = Math.round((lo.atMs + hi.atMs) / 2);
      const g = await settled(mid);
      // Which side does the middle look like? The change lies between it and the other side.
      if (abs(g - lo.gap) <= abs(g - hi.gap)) lo = { atMs: mid, gap: g };
      else hi = { atMs: mid, gap: g };
    }
    o.log?.(`a change of ${m.size} narrowed to ${new Date(lo.atMs).toISOString().slice(0, 16)}..${new Date(hi.atMs).toISOString().slice(0, 16)}`);
    // The settled readings look up to 2 hours ahead: search the window and those 2 hours.
    const a = await o.near.blockAt(lo.atMs);
    const b = await o.near.blockAt(Math.min(hi.atMs + 2 * HOUR, o.nowMs - 60_000));
    const heights = await supplyMoves(o.near, a.height, b.height, await o.near.supplyAt(a.height), await o.near.supplyAt(b.height));
    const supplyChanges: SupplyEvent[] = [];
    for (const h of heights.slice(0, 40)) supplyChanges.push(...(await o.near.eventsIn(h)));
    steps.push({
      fromMs: lo.atMs, toMs: hi.atMs, before: lo.gap, after: hi.gap, supplyChanges,
      treasuryTxs: o.hotTxs.filter((x) => x.atMs >= lo.atMs - HOUR && x.atMs <= hi.atMs + 3 * HOUR),
    });
  }
  steps.sort((x, y) => x.fromMs - y.fromMs);
  return { overview, steps };
}

/** Every height in (lo, hi] where the supply changed, by halving: a range whose two ends agree is skipped. */
async function supplyMoves(near: NearHistory, lo: number, hi: number, sLo: bigint, sHi: bigint, out: number[] = []): Promise<number[]> {
  if (out.length >= 40 || hi <= lo) return out;
  if (hi - lo === 1) {
    if (sLo !== sHi) out.push(hi);
    return out;
  }
  if (sLo === sHi) return out; // a mint and an equal burn inside would cancel: rare, and not a shortfall
  const mid = Math.floor((lo + hi) / 2);
  const sMid = await near.supplyAt(mid);
  await supplyMoves(near, lo, mid, sLo, sMid, out);
  await supplyMoves(near, mid, hi, sMid, sHi, out);
  return out;
}

interface HistoryCache { address: string; moves: [string, number, string][]; reachedStart: boolean }

/**
 * A treasury's history, kept in a file between runs: each run first fetches what's new since the
 * last one, then pages further back from the oldest transaction it has, up to `pages` pages of
 * 25, saving as it goes. A run cut short by an explorer's rate limit loses nothing.
 */
export async function syncHistory(url: string, address: string, cacheDir: string, pages = 800, log?: (s: string) => void): Promise<{ moves: TreasuryMove[]; reachedStart: boolean; added: number }> {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `history-${address}.json`);
  const cache: HistoryCache = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { address, moves: [], reachedStart: false };
  const known = new Set(cache.moves.map((m) => m[0]));
  const save = () => writeFileSync(path, JSON.stringify(cache));
  const toMove = (t: EsploraTx): [string, number, string] | undefined => {
    const f = hotFlows([t], new Set([address]), 0)[0];
    return f ? [t.txid, f.atMs, f.delta.toString()] : undefined;
  };
  // Free explorers throttle hard after heavy use: ask about once a second and wait out refusals.
  const get = (last?: string) => retrying(() => esploraGet<EsploraTx[]>(url, last ? `/address/${address}/txs/chain/${last}` : `/address/${address}/txs/chain`), 12, 300_000);
  let used = 0;
  let added = 0;
  try {
    // 1. What's new since the last run (newest first, down to a transaction already kept).
    const fresh: [string, number, string][] = [];
    let last: string | undefined;
    let caughtUp = false;
    while (used < pages) {
      const page = await get(last);
      used++;
      for (const t of page) {
        if (known.has(t.txid)) { caughtUp = true; break; }
        const m = toMove(t);
        if (m) fresh.push(m);
      }
      if (caughtUp || page.length < 25) { if (!cache.moves.length && page.length < 25) cache.reachedStart = true; break; }
      last = page[page.length - 1]!.txid;
      if (!cache.moves.length && used % 40 === 0) { cache.moves = [...fresh]; save(); log?.(`${address}: ${fresh.length} transactions read`); }
      await sleep(1_000);
    }
    for (const m of fresh) known.add(m[0]);
    added += fresh.length;
    cache.moves = [...fresh, ...cache.moves.filter((m) => !fresh.some((f) => f[0] === m[0]))];
    save();
    // 2. Further back, from the oldest transaction kept.
    while (used < pages && !cache.reachedStart && cache.moves.length) {
      const oldest = cache.moves[cache.moves.length - 1]![0];
      const page = await get(oldest);
      used++;
      for (const t of page) {
        if (known.has(t.txid)) continue;
        const m = toMove(t);
        if (m) { cache.moves.push(m); known.add(t.txid); added++; }
      }
      if (page.length < 25) cache.reachedStart = true;
      if (used % 40 === 0) { save(); log?.(`${address}: ${cache.moves.length} transactions kept, back to ${new Date(cache.moves[cache.moves.length - 1]![1]).toISOString().slice(0, 10)}`); }
      await sleep(1_000);
    }
  } finally {
    save();
  }
  return { moves: cache.moves.map(([txid, atMs, d]) => ({ txid, atMs, delta: BigInt(d) })), reachedStart: cache.reachedStart, added };
}

export async function findOrigin(a: {
  asset: string; decimals: number; contract: string; issuerAccounts: string[]; owedNow: bigint; treasury: string; esploraUrl: string;
  rpcUrl?: string; neardataUrl?: string; log?: (s: string) => void; near?: NearHistory; cacheDir?: string; pages?: number;
}): Promise<OriginReport> {
  const log = a.log ?? (() => undefined);
  log(`${a.asset}: reading the treasury's history (kept in ${a.cacheDir ?? "data"} between runs)`);
  const stats = await retrying(() => esploraGet<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number } }>(a.esploraUrl, `/address/${a.treasury}`), 12, 300_000);
  const balanceNow = BigInt(stats.chain_stats.funded_txo_sum) - BigInt(stats.chain_stats.spent_txo_sum);
  const { moves, added } = await syncHistory(a.esploraUrl, a.treasury, a.cacheDir ?? "data", a.pages ?? 800, log);
  const complete = moves.reduce((t, f) => t + f.delta, 0n) === balanceNow;
  const first = moves.length ? Math.min(...moves.map((f) => f.atMs)) : undefined;
  const txs = { length: moves.length };
  log(`${a.asset}: ${moves.length} treasury transactions (${added} new this run)${complete ? ", complete back to its first" : ""}${first ? `, back to ${new Date(first).toISOString().slice(0, 10)}` : ""}; sampling the shortfall on NEAR`);
  const archive = a.near ? undefined : archivalNear({ contract: a.contract, issuerAccounts: a.issuerAccounts, rpcUrls: a.rpcUrl ? [a.rpcUrl] : undefined, neardataUrl: a.neardataUrl, cacheFile: join(a.cacheDir ?? "data", `near-archive-${a.contract}.json`), log });
  const near = a.near ?? archive!;
  const nowMs = Date.now();
  // A complete history starts at zero: begin a week before it to see the supply that came first.
  const startMs = complete && first ? first - 7 * DAY : (first ?? nowMs - 30 * DAY);
  const gapNow = a.owedNow - balanceNow;
  const absGap = gapNow < 0n ? -gapNow : gapNow;
  const threshold = [a.owedNow / 2000n, absGap / 10n].reduce((x, y) => (x > y ? x : y));
  let found: Awaited<ReturnType<typeof locateShortfall>>;
  try {
    found = await locateShortfall({
    near, hotAt: treasuryAt(moves, balanceNow), hotTxs: moves,
    startMs, nowMs, threshold, log: (s) => log(`${a.asset}: ${s}`),
    });
  } finally {
    archive?.flush(); // keep every answer for the next run, even when this one is cut short
  }
  const { overview, steps } = found;
  // Deposits inside a step: follow each to the address it paid, and read that address now.
  const deposits: OriginReport["deposits"] = [];
  for (const s of steps) for (const e of s.supplyChanges) {
    const m = e.memo?.match(/"txHash":"([0-9a-f]{64})"/);
    if (e.kind !== "mint" || !m) continue;
    const d: OriginReport["deposits"][number] = { nearTx: e.nearTx, sourceTx: m[1]!, amount: e.delta };
    try {
      d.address = await depositRecipient("esplora", a.esploraUrl, m[1]!, e.delta);
      if (d.address) {
        const st = await esploraGet<{ chain_stats: { funded_txo_sum: number; spent_txo_sum: number } }>(a.esploraUrl, `/address/${d.address}`);
        d.balanceNow = BigInt(st.chain_stats.funded_txo_sum) - BigInt(st.chain_stats.spent_txo_sum);
      }
    } catch {
      /* leave unknown */
    }
    deposits.push(d);
  }
  return { asset: a.asset, decimals: a.decimals, treasury: a.treasury, treasuryComplete: complete, treasuryFirstMs: first, treasuryTxs: txs.length, startMs, overview, steps, deposits };
}

/** Each treasury transaction with how much it changed the balance. */
export function treasuryMoves(txs: EsploraTx[], treasury: string): { txid: string; atMs: number; delta: bigint }[] {
  const seen = new Set<string>();
  const out: { txid: string; atMs: number; delta: bigint }[] = [];
  for (const t of txs) {
    if (seen.has(t.txid)) continue;
    seen.add(t.txid);
    const f = hotFlows([t], new Set([treasury]), 0)[0];
    if (f) out.push({ txid: t.txid, atMs: f.atMs, delta: f.delta });
  }
  return out;
}

export function printOrigin(r: OriginReport, c: { green: (s: string) => string; yellow: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string }): void {
  const sym = r.asset.split(":")[0]!.toUpperCase();
  const u = (v: bigint) => `${v < 0n ? "-" : ""}${units((v < 0n ? -v : v).toString(), r.decimals)} ${sym}`;
  const day = (ms?: number) => (ms === undefined ? "?" : new Date(ms).toISOString().slice(0, 10));
  const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  console.log("");
  console.log(c.bold(`${r.asset}  where the shortfall came from`));
  console.log(r.treasuryComplete
    ? c.green(`  treasury ${r.treasury}: all ${r.treasuryTxs} transactions since its first on ${day(r.treasuryFirstMs)} add up to its balance now. History complete.`)
    : c.yellow(`  treasury ${r.treasury}: ${r.treasuryTxs} transactions back to ${day(r.treasuryFirstMs)}; they don't reach its first, so the search starts there.`));
  console.log(`  shortfall (credited on NEAR minus treasury, settled over 2 hours), from ${day(r.startMs)}:`);
  const step = Math.max(1, Math.floor(r.overview.length / 10));
  console.log(`    ${r.overview.filter((_, i) => i % step === 0 || i === r.overview.length - 1).map((p) => `${day(p.atMs)} ${u(p.gap)}`).join(", ")}`);
  if (!r.steps.length) console.log(c.dim(`  it never changed by a noticeable amount between samples: it was there from the first one`));
  for (const s of r.steps) {
    console.log(c.yellow(`  between ${minute(s.fromMs)} and ${minute(s.toMs)} UTC it went from ${u(s.before)} to ${u(s.after)}:`));
    for (const e of s.supplyChanges) console.log(`    NEAR ${e.kind} ${u(e.delta)}  to/from ${e.owner}  ${minute(e.atMs)}  block ${e.height}  tx ${e.nearTx}${e.memo ? `  ${e.memo.slice(0, 140)}` : ""}`);
    for (const t of s.treasuryTxs) console.log(`    treasury ${u(t.delta)}  ${minute(t.atMs)}  tx ${t.txid}`);
    if (!s.supplyChanges.length && !s.treasuryTxs.length) console.log(c.dim(`    no supply change or treasury transaction found in that window`));
  }
  for (const d of r.deposits) console.log(`  deposit credited in ${d.nearTx}: Bitcoin tx ${d.sourceTx} paid ${d.address ?? "an address not found"}${d.balanceNow !== undefined ? `, which holds ${u(d.balanceNow)} now` : ""}`);
}

/** Miner fees around a treasury: what its own spends paid, and what transactions paying into it paid. */
export interface FeeTally {
  address: string;
  /** The oldest transaction read so far: the next run continues from it. */
  cursor?: string;
  done: boolean;
  spendFees: string;
  spendTxs: number;
  inFees: string;
  inTxs: number;
  oldestMs?: number;
}

/** Adds one page of transactions to a tally. A fee is what went in minus what came out. */
export function tallyFees(tally: FeeTally, txs: EsploraTx[]): FeeTally {
  let spend = BigInt(tally.spendFees);
  let into = BigInt(tally.inFees);
  for (const t of txs) {
    if (!t.status?.block_time || t.vin.some((i) => !i.prevout)) continue; // unconfirmed, or newly mined coins
    const fee = t.vin.reduce((n, i) => n + BigInt(i.prevout!.value), 0n) - t.vout.reduce((n, o) => n + BigInt(o.value), 0n);
    if (fee < 0n) continue;
    if (t.vin.some((i) => i.prevout!.scriptpubkey_address === tally.address)) { spend += fee; tally.spendTxs++; }
    else { into += fee; tally.inTxs++; }
    const at = t.status.block_time * 1000;
    if (!tally.oldestMs || at < tally.oldestMs) tally.oldestMs = at;
  }
  tally.spendFees = spend.toString();
  tally.inFees = into.toString();
  return tally;
}

/** Reads a treasury's whole history once, keeping only the fee totals. Stops and resumes where it left off. */
export async function syncFees(url: string, address: string, cacheDir: string, pages = 2000, log?: (s: string) => void): Promise<FeeTally> {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `fees-${address}.json`);
  const tally: FeeTally = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { address, done: false, spendFees: "0", spendTxs: 0, inFees: "0", inTxs: 0 };
  for (let used = 0; !tally.done && used < pages; used++) {
    const page = await retrying(() => esploraGet<EsploraTx[]>(url, tally.cursor ? `/address/${address}/txs/chain/${tally.cursor}` : `/address/${address}/txs/chain`), 12, 300_000);
    tallyFees(tally, page);
    if (page.length < 25) tally.done = true;
    else tally.cursor = page[page.length - 1]!.txid;
    writeFileSync(path, JSON.stringify(tally));
    if (used % 40 === 39) log?.(`${address}: ${tally.spendTxs + tally.inTxs} transactions read`);
    if (!tally.done) await sleep(1_000);
  }
  return tally;
}
