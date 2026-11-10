import type { CreditEvent, SolverFill, WithdrawalEvent } from "@watchtower/core";
import { fetchJson, type HttpOptions } from "./http.ts";
import { parseEventLog, type FtMintBurn, type FtTransfer, type MtMintBurn, type TokenDiff } from "./events.ts";

/**
 * Block-by-block indexer over neardata.xyz (FastNEAR's free NEAR Lake mirror). Every block
 * comes with shards, receipts and execution outcomes including logs, so one fetch per block
 * yields every bridge mint/burn and every settled intent.
 *
 *   https://mainnet.neardata.xyz/v0/block/{height}
 */
export interface NeardataBlock {
  block: { header: { height: number; timestamp_nanosec?: string; timestamp?: number; hash: string } };
  shards: {
    shard_id?: number;
    receipt_execution_outcomes?: {
      receipt: { receiver_id: string; predecessor_id: string; receipt_id: string };
      execution_outcome: { id: string; outcome: { logs: string[]; executor_id: string; status: unknown } };
      tx_hash?: string;
    }[];
  }[];
}

export interface TokenBinding {
  /** NEAR contract that mints/burns this bridged asset, e.g. "btc.omft.near" */
  contract: string;
  /** For multi-token bridges, the token id inside that contract. */
  mtTokenId?: string;
  asset: string;
  chain: string;
}

export interface IndexedBlock {
  height: number;
  timeMs: number;
  credits: CreditEvent[];
  withdrawals: WithdrawalEvent[];
  fills: SolverFill[];
}

/** Where several local watchers share downloaded block slices (see FileBlockCache in the watcher). */
export interface BlockCache {
  get<T>(key: string, load: () => Promise<T>): Promise<T>;
}

/** NEAR's shard layout: which shard an account's receipts (and their logs) execute on. */
export interface ShardLayout {
  boundaries: string[];
  shardIds: number[];
}

/** Reads any layout version that lists boundary accounts: V1, V2, and V3 (mainnet since 2026). */
export function parseShardLayout(raw: unknown): ShardLayout | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const versions = Object.entries(raw as Record<string, unknown>).sort(([a], [b]) => (a < b ? 1 : -1)); // newest first
  for (const [, v] of versions) {
    const l = v as { boundary_accounts?: unknown; shard_ids?: unknown };
    if (!Array.isArray(l?.boundary_accounts)) continue;
    const boundaries = l.boundary_accounts as string[];
    const ids = Array.isArray(l.shard_ids) ? (l.shard_ids as number[]) : Array.from({ length: boundaries.length + 1 }, (_, i) => i);
    if (ids.length !== boundaries.length + 1) continue;
    return { boundaries, shardIds: ids };
  }
  return undefined;
}

/** Same rule as nearcore: the shard index is the number of boundary accounts at or below the account. */
export function shardOf(layout: ShardLayout, account: string): number {
  let i = 0;
  for (const b of layout.boundaries) {
    if (account < b) break;
    i++;
  }
  return layout.shardIds[i] ?? i;
}

/**
 * Which shards hold these accounts, worked out from one whole block when the RPC won't give the
 * layout: every shard's receipts span a range of account names, so an account falls inside one
 * range or between two (then both are kept, to be safe).
 */
export function shardsFromBlock(b: NeardataBlock, accounts: string[]): number[] | undefined {
  const ranges: { id: number; min: string; max: string }[] = [];
  for (const sh of b.shards) {
    if (sh.shard_id === undefined) return undefined;
    const names = (sh.receipt_execution_outcomes ?? []).map((o) => o.execution_outcome.outcome.executor_id).sort();
    if (names.length) ranges.push({ id: sh.shard_id, min: names[0]!, max: names[names.length - 1]! });
  }
  if (ranges.length < 2) return undefined;
  ranges.sort((x, y) => (x.min < y.min ? -1 : 1));
  const out = new Set<number>();
  for (const a of accounts) {
    const i = ranges.findIndex((r) => a <= r.max);
    if (i === -1) out.add(ranges[ranges.length - 1]!.id);
    else if (a >= ranges[i]!.min || i === 0) out.add(ranges[i]!.id);
    else { out.add(ranges[i - 1]!.id); out.add(ranges[i]!.id); }
  }
  return [...out].sort((x, y) => x - y);
}

type Outcome = NeardataBlock["shards"][number] extends { receipt_execution_outcomes?: (infer O)[] } ? O : never;

export class NeardataIndexer {
  /** Shared cache for block slices; several watchers on one machine then download each block once. */
  cache?: BlockCache;

  constructor(
    readonly baseUrl = "https://mainnet.neardata.xyz/v0",
    readonly bindings: TokenBinding[] = [],
    readonly intentsContract = "intents.near",
    readonly http: HttpOptions = {},
    /** Map an intents.near token id (e.g. "nep141:btc.omft.near") to an asset key, and price it in USD cents. */
    readonly tokenToAsset: (tokenId: string) => string | undefined = () => undefined,
    readonly tokenUsdCents: (tokenId: string, amount: bigint) => bigint = () => 0n,
  ) {}

  async fetchBlock(height: number): Promise<NeardataBlock | null> {
    return fetchJson<NeardataBlock | null>(`${this.baseUrl}/block/${height}`, {}, this.http);
  }

  /**
   * A block reduced to what Watchtower reads: its header plus the receipts that logged something on
   * the given shards. Downloads the small header and one slice per shard instead of the whole block.
   */
  async fetchSlim(height: number, shards: number[]): Promise<NeardataBlock | null> {
    const load = <T,>(key: string, fn: () => Promise<T>) => (this.cache ? this.cache.get(`${height}-${key}`, fn) : fn());
    const head = await load("h", async () => {
      const r = await fetchJson<{ header?: NeardataBlock["block"]["header"]; block?: { header: NeardataBlock["block"]["header"] }; chunks?: { shard_id: number }[] } | null>(`${this.baseUrl}/block/${height}/headers`, {}, this.http);
      const header = r?.header ?? r?.block?.header;
      return header ? { header: { height: header.height, timestamp_nanosec: header.timestamp_nanosec, hash: header.hash }, shards: r?.chunks?.map((c) => c.shard_id) } : null;
    });
    if (!head) return null;
    const present = head.shards ? new Set(head.shards) : undefined;
    const slices = await Promise.all(shards.filter((s) => !present || present.has(s)).map((s) =>
      load(`s${s}`, async () => {
        const r = await fetchJson<{ receipt_execution_outcomes?: Outcome[] } | null>(`${this.baseUrl}/block/${height}/shard/${s}`, {}, this.http);
        if (!r) return null;
        // Keep only receipts that logged something: that is all parse() reads.
        return (r.receipt_execution_outcomes ?? []).filter((o) => o.execution_outcome.outcome.logs.length > 0).map((o) => ({
          execution_outcome: { id: o.execution_outcome.id, outcome: { logs: o.execution_outcome.outcome.logs, executor_id: o.execution_outcome.outcome.executor_id, status: null } },
          tx_hash: o.tx_hash,
        }));
      }),
    ));
    return { block: { header: head.header }, shards: slices.filter((x) => x !== null).map((x) => ({ receipt_execution_outcomes: x as unknown as Outcome[] })) };
  }

  async lastFinalHeight(): Promise<number> {
    const b = await fetchJson<NeardataBlock>(`${this.baseUrl}/last_block/final`, {}, this.http);
    return b.block.header.height;
  }

  parse(b: NeardataBlock): IndexedBlock {
    const h = b.block.header;
    const timeMs = h.timestamp_nanosec ? Number(BigInt(h.timestamp_nanosec) / 1_000_000n) : Math.floor((h.timestamp ?? 0) / 1_000_000);
    const out: IndexedBlock = { height: h.height, timeMs, credits: [], withdrawals: [], fills: [] };
    const byContract = new Map(this.bindings.map((x) => [x.contract, x]));
    const diffsByTx = new Map<string, TokenDiff[]>();
    // intents.near mt_mint / mt_burn per tx: tells us the real user behind a bridge mint/burn
    // whose NEP-141 owner is intents.near itself.
    const intentsMoves = new Map<string, { kind: "mint" | "burn"; owner: string; amount: bigint }[]>();
    // PoA deposits: the bridge mints to its own account, then hands the tokens on with a
    // "BRIDGED_FROM" note naming the home-chain transaction. That hand-over is the credit.
    const bridged: (CreditEvent & { from: string })[] = [];

    for (const shard of b.shards) {
      for (const r of shard.receipt_execution_outcomes ?? []) {
        const executor = r.execution_outcome.outcome.executor_id;
        const txh = r.tx_hash ?? r.execution_outcome.id;
        const logsBurn = r.execution_outcome.outcome.logs.some((l) => parseEventLog(l)?.event === "ft_burn");
        r.execution_outcome.outcome.logs.forEach((log, i) => {
          const ev = parseEventLog(log);
          if (!ev) return;
          const id = `${r.execution_outcome.id}:${i}`;
          const binding = byContract.get(executor);
          if (binding && ev.standard === "nep141") {
            for (const [j, d] of (ev.data as FtMintBurn[]).entries()) {
              if (ev.event === "ft_mint") out.credits.push({ id: `${id}:${j}`, asset: binding.asset, amount: BigInt(d.amount), account: d.owner_id, nearTx: txh, atMs: timeMs, sourceTxRef: sourceRefFromMemo(d.memo) });
              if (ev.event === "ft_burn") out.withdrawals.push({ id: `${id}:${j}`, asset: binding.asset, amount: BigInt(d.amount), account: d.owner_id, nearTx: txh, destChain: binding.chain, destAddress: destFromMemo(d.memo), atMs: timeMs });
            }
            if (ev.event === "ft_transfer") {
              for (const [j, d] of (ev.data as FtTransfer[]).entries()) {
                // Some PoA tokens (SOL's) log no burn: a withdrawal is a transfer to the bridge with
                // "WITHDRAW_TO:<address>". Where a burn is logged, the burn already counts.
                const dest = destFromMemo(d.memo);
                if (dest && !logsBurn) out.withdrawals.push({ id: `${id}:${j}`, asset: binding.asset, amount: BigInt(d.amount), account: d.old_owner_id, nearTx: txh, destChain: binding.chain, destAddress: dest, atMs: timeMs });
                const src = bridgedFrom(d.memo);
                if (src) bridged.push({ id: `${id}:${j}`, asset: binding.asset, amount: BigInt(d.amount), account: d.new_owner_id, nearTx: txh, atMs: timeMs, sourceTxRef: src.txHash, sourceChain: src.chain, from: d.old_owner_id });
              }
            }
          }
          if (ev.standard === "nep245" && (ev.event === "mt_mint" || ev.event === "mt_burn")) {
            for (const [j, d] of (ev.data as MtMintBurn[]).entries()) {
              d.token_ids.forEach((tid, k) => {
                const mb = this.bindings.find((x) => x.contract === executor && x.mtTokenId === tid);
                if (!mb) return;
                const amount = BigInt(d.amounts[k] ?? "0");
                if (ev.event === "mt_mint") out.credits.push({ id: `${id}:${j}:${k}`, asset: mb.asset, amount, account: d.owner_id, nearTx: txh, atMs: timeMs, sourceTxRef: sourceRefFromMemo(d.memo) });
                else out.withdrawals.push({ id: `${id}:${j}:${k}`, asset: mb.asset, amount, account: d.owner_id, nearTx: txh, destChain: mb.chain, destAddress: destFromMemo(d.memo), atMs: timeMs });
              });
            }
          }
          if (executor === this.intentsContract && ev.standard === "nep245" && (ev.event === "mt_mint" || ev.event === "mt_burn")) {
            const list = intentsMoves.get(txh) ?? [];
            for (const d of ev.data as MtMintBurn[]) d.amounts.forEach((a) => list.push({ kind: ev.event === "mt_mint" ? "mint" : "burn", owner: d.owner_id, amount: BigInt(a) }));
            intentsMoves.set(txh, list);
          }
          if (executor === this.intentsContract && ev.standard === "dip4" && ev.event === "token_diff") {
            const list = diffsByTx.get(txh) ?? [];
            list.push(...(ev.data as TokenDiff[]));
            diffsByTx.set(txh, list);
          }
        });
      }
    }
    for (const b of bridged) {
      // Replace the bridge's mint to itself with the hand-over, which names the user and the deposit.
      const i = out.credits.findIndex((c) => c.nearTx === b.nearTx && c.asset === b.asset && c.account === b.from && c.amount === b.amount);
      if (i >= 0) out.credits.splice(i, 1);
      const { from: _from, ...credit } = b;
      out.credits.push(credit);
    }
    const attribute = (e: { account: string; amount: bigint; nearTx: string }, kind: "mint" | "burn") => {
      if (e.account !== this.intentsContract) return;
      const m = intentsMoves.get(e.nearTx)?.find((x) => x.kind === kind && x.amount === e.amount);
      if (m) e.account = m.owner;
    };
    out.credits.forEach((c) => attribute(c, "mint"));
    out.withdrawals.forEach((w) => attribute(w, "burn"));
    out.fills = fillsFromTokenDiffs(diffsByTx, timeMs, this.tokenToAsset, this.tokenUsdCents);
    return out;
  }
}

/** PoA deposits: 'BRIDGED_FROM:{"networkType":"btc","chainId":"mainnet","txHash":"…"}'. */
export function bridgedFrom(memo?: string): { chain?: string; txHash?: string } | undefined {
  if (!memo?.startsWith("BRIDGED_FROM:")) return undefined;
  try {
    const j = JSON.parse(memo.slice("BRIDGED_FROM:".length)) as { networkType?: string; chainId?: string | number; txHash?: string };
    return { chain: j.networkType && j.chainId !== undefined ? `${j.networkType}:${j.chainId}` : undefined, txHash: j.txHash };
  } catch {
    return { txHash: sourceRefFromMemo(memo) };
  }
}

/** PoA withdrawals name the payout address in the burn memo: "WITHDRAW_TO:<address>". */
export function destFromMemo(memo?: string): string | undefined {
  const m = memo ? /WITHDRAW_TO:([A-Za-z0-9]{20,100})/.exec(memo) : null;
  return m?.[1];
}

/** Bridges often stamp the source tx into the mint memo; accept a few common shapes. */
export function sourceRefFromMemo(memo?: string): string | undefined {
  if (!memo) return undefined;
  const m = /(0x[0-9a-fA-F]{64}|\b[0-9a-f]{64}\b|[1-9A-HJ-NP-Za-km-z]{80,90})/.exec(memo);
  return m?.[1];
}

/**
 * A settled swap shows up as ≥2 token_diff entries in one transaction: the user's and the
 * solver's mirror-image diff. The solver is the counterparty that also appears as a
 * counterparty in many other transactions; per transaction we take the account whose diff is
 * the exact negation of another's and that is not the first signer (the user's intent).
 */
export function fillsFromTokenDiffs(
  diffsByTx: Map<string, TokenDiff[]>,
  atMs: number,
  tokenToAsset: (tokenId: string) => string | undefined,
  usdCents: (tokenId: string, amount: bigint) => bigint,
): SolverFill[] {
  const fills: SolverFill[] = [];
  for (const [tx, diffs] of diffsByTx) {
    if (diffs.length < 2) continue;
    const user = diffs[0]!;
    const spent = Object.entries(user.diff).find(([, v]) => v.startsWith("-"));
    const got = Object.entries(user.diff).find(([, v]) => !v.startsWith("-") && v !== "0");
    if (!spent || !got) continue;
    const src = tokenToAsset(spent[0]);
    const dst = tokenToAsset(got[0]);
    if (!src || !dst) continue;
    const solvers = diffs.slice(1).filter((d) => d.account_id !== user.account_id);
    if (solvers.length === 0) continue;
    const value = usdCents(spent[0], -BigInt(spent[1]));
    // Split the fill across solvers in proportion to how much of the user's input each took.
    const takes = solvers.map((s) => BigInt(s.diff[spent[0]] ?? "0")).map((v) => (v > 0n ? v : 0n));
    const total = takes.reduce((a, b) => a + b, 0n);
    solvers.forEach((s, i) => {
      const share = total > 0n ? (value * takes[i]!) / total : value / BigInt(solvers.length);
      fills.push({ id: `${tx}:${s.account_id}`, route: `${src}->${dst}`, solver: s.account_id, usdCents: share, atMs });
    });
  }
  return fills;
}
