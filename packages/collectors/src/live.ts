import type { AssetKey, ChainId, ObservationBatch, PriceObs } from "@watchtower/core";
import { DEFAULT_ASSETS } from "@watchtower/core";
import { EsploraReader, EvmReader, SolanaReader, type ChainReader } from "./chains.ts";
import { httpStats, type HttpOptions } from "./http.ts";
import { NearRpc, bridgeHeld } from "./near.ts";
import { NeardataIndexer, parseShardLayout, shardOf, shardsFromBlock, type BlockCache, type ShardLayout, type TokenBinding } from "./neardata.ts";
import { assetsFromTokens, OneClickClient } from "./oneclick.ts";

/**
 * Live data for the engine, pinned to epoch boundaries.
 *
 * Determinism across watchers: every watcher collects for the same epoch E and only uses data
 * at or before the epoch boundary (NEAR blocks with timestamp <= E, source-chain blocks at the
 * last height whose time <= E). Watchers reading the same chains therefore build the same
 * batch and sign the same hash. Disagreement means a data source lied or lagged — which is
 * itself worth surfacing.
 */
export interface LiveAssetConfig {
  /** Custody addresses on the home chain (cold + hot). */
  custody: string[];
  hotWallets?: string[];
  /** ERC-20 / SPL token address on the home chain; omit for the native coin. */
  token?: string;
  /** NEAR contract that mints/burns the bridged token (e.g. "btc.omft.near"). */
  nearContract: string;
  /** For multi-token bridges: token id inside nearContract. */
  mtTokenId?: string;
  /**
   * True only if users deposit straight into the custody addresses. Bridges that give each user
   * their own deposit address (PoA does) must leave this off: transfers into custody are then
   * sweeps, which would count as unmatched deposits, and the ghost-credit check can't run.
   */
  depositsToCustody?: boolean;
  /**
   * The bridge's own NEAR accounts for this token (its minter, its withdrawal receiver). Tokens
   * they hold are owed to no user, so they come off the credited supply.
   */
  issuerAccounts?: string[];
  /**
   * Custody is the bridge's whole treasury but holds only part of what users are owed: the
   * shortfall measured by `watchtower custody --history`, in base units (strings in JSON). The
   * route is "partly verified", never green, and red if the shortfall grows past this range.
   */
  partial?: { baselineGap: string; smallGap: string; alarmGap: string; persistMs: number; sinceMs: number; measuredAtMs?: number };
}

export interface LiveConfig {
  near: {
    rpcUrl: string;
    neardataUrl: string;
    intentsContract: string;
    /** FastNEAR API key (dashboard.fastnear.com) for higher limits; sent only to the NEAR RPC and neardata. */
    apiKey?: string;
  };
  oneClickUrl: string;
  chains: Record<ChainId, { kind: "esplora" | "evm" | "solana"; url: string }>;
  assets: Record<AssetKey, LiveAssetConfig>;
  http?: HttpOptions;
  /** Max NEAR blocks to fetch in parallel (the watcher adapts between 1 and this; default 6). */
  concurrency?: number;
  /** Stop indexing a round after this long and carry on next round (default 40 s). */
  indexBudgetMs?: number;
  /**
   * Stop indexing a round after downloading this many megabytes (default 1). Reading every NEAR
   * block costs about 50 MB a minute; verdicts don't need every block, so a watcher on a home
   * connection reads what fits and skips ahead when it falls behind.
   */
  indexBudgetMb?: number;
  /** After an outage, index at most this many blocks per round and skip the rest (default 400, about 4 minutes). */
  maxBlocksPerRound?: number;
}

export class LiveCollector {
  readonly near: NearRpc;
  readonly readers = new Map<ChainId, ChainReader>();
  private indexer: NeardataIndexer;
  private layout?: { at: number; value?: ShardLayout };
  private learned?: { at: number; shards: number[] };
  /** Blocks skipped in the last round to catch up after an outage (0 normally). */
  skippedBlocks = 0;
  /** Shards indexed in the last round, or undefined when whole blocks were fetched. */
  indexedShards?: number[];
  /** NEAR blocks indexed in the last round. */
  indexedBlocks = 0;
  /** Blocks still to read after the last round (how far behind the chain the watcher is). */
  behindBlocks = 0;
  /** Why the last round stopped reading early, if it did. */
  indexStop?: string;
  private conc?: number;
  private nearCursor?: number;
  private depositCursorMs = new Map<AssetKey, number>();
  private tokenIdToAsset = new Map<string, string>();
  private prices = new Map<string, PriceObs>();
  private decimals = new Map<string, number>();
  /** Configured assets plus bridged ones found in the 1Click list (supply and events only, no custody). */
  readonly assets: Map<AssetKey, LiveAssetConfig>;

  constructor(readonly cfg: LiveConfig) {
    this.assets = new Map(Object.entries(cfg.assets));
    const nearHttp = cfg.near.apiKey ? { ...cfg.http, headers: { ...cfg.http?.headers, authorization: `Bearer ${cfg.near.apiKey}` } } : cfg.http;
    this.near = new NearRpc(cfg.near.rpcUrl, nearHttp);
    for (const [id, c] of Object.entries(cfg.chains)) {
      this.readers.set(id, c.kind === "esplora" ? new EsploraReader(id, c.url, cfg.http) : c.kind === "evm" ? new EvmReader(id, c.url, cfg.http) : new SolanaReader(c.url, cfg.http));
    }
    const bindings: TokenBinding[] = [...this.assets].map(([asset, a]) => ({ contract: a.nearContract, mtTokenId: a.mtTokenId, asset, chain: asset.split(":")[1]! }));
    // Block slices can be large on a busy shard: give them longer on a slow connection, retry once.
    const blockHttp = { ...nearHttp, timeoutMs: Math.max(nearHttp?.timeoutMs ?? 0, 20_000), retries: 1 };
    this.indexer = new NeardataIndexer(cfg.near.neardataUrl, bindings, cfg.near.intentsContract, blockHttp, (t) => this.tokenIdToAsset.get(t), (t, amt) => this.usdCents(t, amt));
  }

  /** Share downloaded block slices with other watchers on this machine. */
  setBlockCache(cache: BlockCache): void {
    this.indexer.cache = cache;
  }

  /** Shards holding intents.near and the bridge token contracts; refreshed hourly. Undefined if unknown. */
  private async shards(): Promise<number[] | undefined> {
    if (!this.layout || Date.now() - this.layout.at > 3_600_000) {
      try {
        this.layout = { at: Date.now(), value: parseShardLayout(await this.near.shardLayout()) };
      } catch {
        this.layout = { at: Date.now() - 3_300_000, value: this.layout?.value }; // retry in 5 minutes
      }
    }
    const l = this.layout.value;
    if (!l) return this.learned && Date.now() - this.learned.at < 3_600_000 ? this.learned.shards : undefined;
    return [...new Set(this.watchedAccounts().map((a) => shardOf(l, a)))].sort((a, b) => a - b);
  }

  private watchedAccounts(): string[] {
    return [this.cfg.near.intentsContract, ...this.indexer.bindings.map((b) => b.contract)];
  }

  private usdCents(tokenId: string, amount: bigint): bigint {
    const asset = this.tokenIdToAsset.get(tokenId);
    const p = asset ? this.prices.get(asset) : undefined;
    const d = asset ? this.decimals.get(asset) : undefined;
    if (!p || d === undefined) return 0n;
    return (amount * p.priceMicroUsd) / (10n ** BigInt(d) * 10_000n);
  }

  async collect(asOfMs: number): Promise<ObservationBatch> {
    const batch: ObservationBatch = { asOfMs, supply: [], custody: [], hotWallets: [], chains: [], credits: [], deposits: [], withdrawals: [], fills: [], prices: [], depositFeeds: [], custodyConfigured: [] };

    // 1. Prices and the token registry (1Click).
    try {
      const tokens = await new OneClickClient(this.cfg.oneClickUrl, this.cfg.http).tokens();
      const { assets, prices, byTokenId } = assetsFromTokens(tokens);
      this.tokenIdToAsset = byTokenId;
      this.discover(byTokenId);
      for (const a of assets) this.decimals.set(a.key, a.decimals);
      for (const p of prices) this.prices.set(p.asset, { ...p, atMs: Math.min(p.atMs, asOfMs) });
      batch.prices = [...this.prices.values()];
    } catch {
      /* stale prices fail closed inside the engine for stablecoins */
    }

    // 2. Chain heads.
    const near = await this.near.head().catch(() => undefined);
    if (near) batch.chains!.push({ chain: "near", headHeight: near.headHeight, headTimeMs: near.headTimeMs, atMs: asOfMs });
    await Promise.all([...this.readers.values()].map(async (r) => {
      const h = await r.head().catch(() => undefined);
      if (h) batch.chains!.push({ ...h, atMs: asOfMs });
    }));

    // 3. NEAR side: index every final block up to the epoch boundary.
    this.skippedBlocks = 0;
    this.indexedBlocks = 0;
    if (near) {
      const final = near.headHeight;
      const cap = this.cfg.maxBlocksPerRound ?? 400;
      // First round: start a little before the epoch boundary. The newest final block is always a
      // few seconds past it, so starting there would never find a block to begin from. NEAR makes
      // a block at most every ~0.5 s; assume 0.25 s to be sure to reach back far enough.
      const back = Math.ceil(Math.max(0, near.headTimeMs - asOfMs) / 250) + 5;
      let from = this.nearCursor === undefined ? Math.max(0, final - Math.min(back, cap)) : this.nearCursor + 1;
      if (final - from + 1 > cap) {
        // Fell behind (outage, sleep): stay live rather than spend the next hour catching up.
        this.skippedBlocks = final - cap + 1 - from;
        from = final - cap + 1;
      }
      const heights = Array.from({ length: Math.max(0, final - from + 1) }, (_, i) => from + i);
      // Adaptive: halve on a failed download, grow back by one after each clean batch.
      const maxConc = this.cfg.concurrency ?? 6;
      this.conc ??= Math.min(4, maxConc);
      const deadline = Date.now() + (this.cfg.indexBudgetMs ?? 40_000);
      const budgetMb = this.cfg.indexBudgetMb ?? 1;
      const byteLimit = httpStats.bytes + budgetMb * 1_000_000;
      this.indexStop = undefined;
      const shards = await this.shards();
      this.indexedShards = shards;
      // Walk forward in order. Stop at the first block past the epoch boundary (it belongs to the
      // next round) or the first failed download (retried next round): the cursor only ever moves
      // past heights that were fully handled, so no deposit or withdrawal is skipped.
      let done = this.nearCursor;
      let failure: string | undefined;
      blocks: for (let i = 0; i < heights.length; ) {
        if (Date.now() > deadline) { this.indexStop = "out of time for this round"; break; }
        if (httpStats.bytes > byteLimit) { this.indexStop = `data limit for this round (${budgetMb} MB)`; break; }
        const conc = this.conc;
        const blocks = await Promise.all(heights.slice(i, i + conc).map((h) => (shards ? this.indexer.fetchSlim(h, shards) : this.indexer.fetchBlock(h)).catch((e: unknown) => {
          failure ??= describeHttpError(e);
          return Symbol("failed");
        })));
        if (failure) this.conc = Math.max(1, Math.floor(conc / 2));
        else this.conc = Math.min(maxConc, conc + 1);
        i += conc;
        for (const [k, b] of blocks.entries()) {
          const h = heights[i - conc + k]!;
          if (typeof b === "symbol") { this.indexStop = failure; break blocks; }
          if (!b) { done = h; continue; } // no block at this height
          // Whole-block fallback: learn the shards from this block, so the next rounds fetch only those.
          if (!shards && !this.learned) {
            const s = shardsFromBlock(b, this.watchedAccounts());
            if (s) this.learned = { at: Date.now(), shards: s };
          }
          const ib = this.indexer.parse(b);
          if (ib.timeMs > asOfMs) break blocks;
          batch.credits!.push(...ib.credits);
          batch.withdrawals!.push(...ib.withdrawals);
          batch.fills!.push(...ib.fills);
          this.indexedBlocks++;
          done = h;
        }
      }
      // A first round that found nothing before the boundary starts from just before it next time.
      this.nearCursor = done ?? (this.indexedBlocks === 0 && heights.length ? from - 1 : this.nearCursor);
      // Blocks up to the epoch boundary still unread (about 2 per second of lag).
      this.behindBlocks = Math.max(0, final - (this.nearCursor ?? final) - Math.ceil(Math.max(0, near.headTimeMs - asOfMs) / 600));
    }

    // 4. Supply on NEAR and custody on each home chain.
    batch.custodyConfigured = [...this.assets].filter(([, a]) => realAddresses(a.custody).length > 0).map(([k]) => k);
    batch.partialBacking = [...this.assets].filter(([, a]) => a.partial && realAddresses(a.custody).length > 0).map(([asset, a]) => ({
      asset, baselineGap: BigInt(a.partial!.baselineGap), smallGap: BigInt(a.partial!.smallGap), alarmGap: BigInt(a.partial!.alarmGap), persistMs: a.partial!.persistMs, sinceMs: a.partial!.sinceMs,
    }));
    for (const [asset, a] of this.assets) {
      const chain = asset.split(":")[1]!;
      const reader = this.readers.get(chain);
      try {
        let credited = a.mtTokenId
          ? BigInt(await this.near.view<string>(a.nearContract, "mt_supply", { token_id: a.mtTokenId }))
          : await this.near.ftTotalSupply(a.nearContract);
        // If a bridge-held balance can't be read, the whole read fails: an overstated supply would
        // look like a hole in the backing.
        if (!a.mtTokenId && a.issuerAccounts?.length) {
          const h = await bridgeHeld(this.near, a.nearContract, a.issuerAccounts, this.cfg.near.intentsContract);
          credited -= h.direct + h.insideIntents;
        }
        if (credited < 0n) credited = 0n;
        batch.supply!.push({ asset, credited, pendingWithdrawals: 0n, atMs: asOfMs });
      } catch {
        /* missing supply -> SUPPLY_DATA_STALE */
      }
      if (!reader) continue;
      // An empty custody list must read as "unknown", never as a balance of zero (a false red).
      const custody = realAddresses(a.custody);
      if (custody.length) {
        try {
          batch.custody!.push({ asset, balance: await reader.balance(custody, a.token), atMs: asOfMs });
        } catch {
          /* missing custody -> CUSTODY_DATA_STALE */
        }
      }
      for (const hw of realAddresses(a.hotWallets)) {
        try {
          batch.hotWallets!.push({ asset, address: hw, balance: await reader.balance([hw], a.token), atMs: asOfMs });
        } catch {
          /* missing hot wallet -> capacity falls back to solver fills */
        }
      }
      if (!custody.length || !a.depositsToCustody) continue;
      try {
        const since = this.depositCursorMs.get(asset) ?? asOfMs - 6 * 3_600_000;
        if (reader.deposits) {
          batch.deposits!.push(...(await reader.deposits(custody, asset, since, a.token)).filter((d) => d.atMs <= asOfMs));
          batch.depositFeeds!.push(asset);
        }
        this.depositCursorMs.set(asset, asOfMs);
      } catch {
        /* deposits retried next epoch */
      }
    }
    return batch;
  }

  /**
   * Bridged assets on Watchtower's routes that the config doesn't list: take their NEAR token
   * from the 1Click list so supply, deposits and withdrawals are still tracked. Custody stays
   * empty (unknown) until it is configured.
   */
  private discover(byTokenId: Map<string, string>): void {
    for (const a of DEFAULT_ASSETS) {
      if (a.bridge === "native" || this.assets.has(a.key)) continue;
      const tokenId = a.nearTokenId ?? [...byTokenId].find(([, k]) => k === a.key)?.[0];
      const src = tokenId ? supplySource(tokenId) : undefined;
      if (!src) continue;
      const hot = a.bridge === "hot" && src.mtTokenId ? hotHomeToken(src.mtTokenId) : undefined;
      this.assets.set(a.key, { custody: [], ...src, ...(hot?.token ? { token: hot.token } : {}) });
      this.indexer.bindings.push({ contract: src.nearContract, mtTokenId: src.mtTokenId, asset: a.key, chain: a.chain });
    }
  }
}

/**
 * The HOT bridge's locker on each EVM chain: deposits are paid into it and withdrawals out of
 * it, so it holds everything the bridge owes on that chain. From HOT's own omni SDK
 * (@hot-labs/omni-sdk 2.25.5, bridge-evm: treasuryDefaultContract, plus its per-chain overrides).
 */
export const HOT_TREASURY_DEFAULT = "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd";
export const HOT_TREASURY_BY_CHAIN: Record<number, string> = { 36900: "0x4a3b9d07a9a1e3d9dfb0a6edfc87384f8f424003" };
export const hotTreasury = (chainId: number) => HOT_TREASURY_BY_CHAIN[chainId] ?? HOT_TREASURY_DEFAULT;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s: string): Uint8Array | undefined {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return undefined;
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) { body.unshift(Number(n & 0xffn)); n >>= 8n; }
  const zeros = /^1*/.exec(s)![0].length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

/**
 * A HOT omni token id on EVM ("56_<base58 of the token address>") read back as its chain id and
 * home token: `token` is the ERC-20 address, or undefined for the chain's native coin
 * ("56_11111111111111111111", twenty zero bytes). Undefined for anything that isn't EVM-shaped.
 */
export function hotHomeToken(mtTokenId: string): { chainId: number; token?: string } | undefined {
  const m = /^(\d+)_([1-9A-HJ-NP-Za-km-z]+)$/.exec(mtTokenId);
  if (!m) return undefined;
  const bytes = base58(m[2]!);
  if (!bytes || bytes.length !== 20) return undefined;
  const chainId = Number(m[1]);
  if (bytes.every((b) => b === 0)) return { chainId };
  return { chainId, token: `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}` };
}

/** Config placeholders such as "<bc1… custody address>" are not addresses. */
export function realAddresses(list?: string[]): string[] {
  return (list ?? []).filter((x) => typeof x === "string" && x.trim() !== "" && !x.startsWith("<"));
}

/** Where to read an intents token's supply: "nep141:btc.omft.near" or "nep245:<contract>:<token id>". */
export function supplySource(tokenId: string): { nearContract: string; mtTokenId?: string } | undefined {
  if (tokenId.startsWith("nep141:")) return { nearContract: tokenId.slice("nep141:".length) };
  const m = /^nep245:([^:]+):(.+)$/.exec(tokenId);
  return m ? { nearContract: m[1]!, mtTokenId: m[2]! } : undefined;
}

/** A short reason for a failed download: "rate limited (HTTP 429)", "timed out", "HTTP 503". */
export function describeHttpError(e: unknown): string {
  const status = (e as { status?: number })?.status;
  if (status === 429) return "rate limited (HTTP 429)";
  if (status) return `HTTP ${status}`;
  const m = String((e as Error)?.message ?? e);
  if (/abort|timed? ?out/i.test(m) || (e as Error)?.name === "AbortError") return "timed out";
  return m.slice(0, 80);
}
