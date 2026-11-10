import type { ChainId, ChainObs, DepositEvent } from "@watchtower/core";
import { fetchJson, jsonRpc, type HttpOptions } from "./http.ts";

/** Anything that can report a chain head and balances for a set of custody addresses. */
export interface ChainReader {
  chain: ChainId;
  head(): Promise<ChainObs>;
  /** Sum of balances (smallest units) held by the addresses, for the given token (undefined = native). */
  balance(addresses: string[], token?: string): Promise<bigint>;
  /** Transfers into the addresses since a cursor. */
  deposits?(addresses: string[], asset: string, sinceMs: number, token?: string): Promise<DepositEvent[]>;
}

// ---------------------------------------------------------------------------------------------
// Bitcoin / Litecoin via Esplora (mempool.space, blockstream.info, litecoinspace.org)
// ---------------------------------------------------------------------------------------------

interface EsploraAddress {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats?: { funded_txo_sum: number; spent_txo_sum: number };
}
interface EsploraTx {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vout: { scriptpubkey_address?: string; value: number }[];
}

/** Public Esplora servers tried after the configured one, so one unreachable host doesn't blind a chain. */
export const ESPLORA_FALLBACKS: Record<string, string[]> = {
  bitcoin: ["https://blockstream.info/api", "https://mempool.space/api"],
  litecoin: ["https://litecoinspace.org/api"],
};

export class EsploraReader implements ChainReader {
  private urls: string[];
  constructor(readonly chain: ChainId, readonly baseUrl: string, readonly http: HttpOptions = {}) {
    this.urls = [...new Set([baseUrl.replace(/\/+$/, ""), ...(ESPLORA_FALLBACKS[chain] ?? [])])];
  }

  /** GET a path from the first server that answers; the one that worked is tried first next time. */
  async get<T>(path: string): Promise<T> {
    let last: unknown;
    for (const [i, u] of this.urls.entries()) {
      try {
        const v = await fetchJson<T>(`${u}${path}`, {}, this.http);
        if (i > 0) this.urls = [u, ...this.urls.filter((x) => x !== u)];
        return v;
      } catch (e) {
        last = e;
        if ((e as { status?: number }).status === 400 || (e as { status?: number }).status === 404) throw e; // the request itself is wrong
      }
    }
    throw last;
  }

  async head(): Promise<ChainObs> {
    const height = await this.get<number>("/blocks/tip/height");
    const blocks = await this.get<{ height: number; timestamp: number }[]>(`/blocks/${height}`);
    const tip = blocks[0]!;
    return { chain: this.chain, headHeight: tip.height, headTimeMs: tip.timestamp * 1000, atMs: Date.now() };
  }

  /** Confirmed balance only: an unconfirmed deposit is not backing yet. */
  async balance(addresses: string[]): Promise<bigint> {
    let sum = 0n;
    for (const a of addresses) {
      const r = await this.get<EsploraAddress>(`/address/${a}`);
      sum += BigInt(r.chain_stats.funded_txo_sum - r.chain_stats.spent_txo_sum);
    }
    return sum;
  }

  async deposits(addresses: string[], asset: string, sinceMs: number): Promise<DepositEvent[]> {
    const out: DepositEvent[] = [];
    for (const a of addresses) {
      const txs = await this.get<EsploraTx[]>(`/address/${a}/txs`);
      for (const tx of txs) {
        const t = (tx.status.block_time ?? Math.floor(Date.now() / 1000)) * 1000;
        if (!tx.status.confirmed || t < sinceMs) continue;
        const amount = tx.vout.filter((o) => o.scriptpubkey_address === a).reduce((s, o) => s + BigInt(o.value), 0n);
        if (amount > 0n) out.push({ id: `${this.chain}:${tx.txid}:${a}`, asset, amount, sourceTx: tx.txid, atMs: t });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// EVM chains via JSON-RPC
// ---------------------------------------------------------------------------------------------

const ERC20_BALANCE_OF = "0x70a08231";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export class EvmReader implements ChainReader {
  constructor(readonly chain: ChainId, readonly rpcUrl: string, readonly http: HttpOptions = {}, readonly finalityTag: "finalized" | "safe" | "latest" = "latest") {}

  async head(): Promise<ChainObs> {
    const latest = await jsonRpc<{ number: string; timestamp: string }>(this.rpcUrl, "eth_getBlockByNumber", ["latest", false], this.http);
    let finalityLagBlocks: number | undefined;
    try {
      const fin = await jsonRpc<{ number: string } | null>(this.rpcUrl, "eth_getBlockByNumber", ["finalized", false], this.http);
      if (fin) finalityLagBlocks = Number(BigInt(latest.number) - BigInt(fin.number));
    } catch {
      /* chains without the finalized tag */
    }
    return { chain: this.chain, headHeight: Number(BigInt(latest.number)), headTimeMs: Number(BigInt(latest.timestamp)) * 1000, finalityLagBlocks, atMs: Date.now() };
  }

  async balance(addresses: string[], token?: string): Promise<bigint> {
    let sum = 0n;
    for (const a of addresses) {
      if (!token) sum += BigInt(await jsonRpc<string>(this.rpcUrl, "eth_getBalance", [a, this.finalityTag], this.http));
      else {
        const data = ERC20_BALANCE_OF + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
        const r = await jsonRpc<string>(this.rpcUrl, "eth_call", [{ to: token, data }, this.finalityTag], this.http);
        sum += r === "0x" ? 0n : BigInt(r);
      }
    }
    return sum;
  }

  /** ERC-20 Transfer logs into the addresses over a block range (callers pin the range per epoch). */
  async tokenDeposits(addresses: string[], asset: string, token: string, fromBlock: number, toBlock: number, blockTimeMs: (n: number) => number): Promise<DepositEvent[]> {
    const topics = [TRANSFER_TOPIC, null, addresses.map((a) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0"))];
    const logs = await jsonRpc<{ transactionHash: string; logIndex: string; blockNumber: string; data: string }[]>(
      this.rpcUrl, "eth_getLogs", [{ address: token, fromBlock: "0x" + fromBlock.toString(16), toBlock: "0x" + toBlock.toString(16), topics }], this.http,
    );
    return logs.map((l) => ({ id: `${this.chain}:${l.transactionHash}:${Number(BigInt(l.logIndex))}`, asset, amount: BigInt(l.data), sourceTx: l.transactionHash, atMs: blockTimeMs(Number(BigInt(l.blockNumber))) }));
  }
}

// ---------------------------------------------------------------------------------------------
// Solana via JSON-RPC
// ---------------------------------------------------------------------------------------------

export class SolanaReader implements ChainReader {
  readonly chain = "solana";
  constructor(readonly rpcUrl: string, readonly http: HttpOptions = {}) {}

  async head(): Promise<ChainObs> {
    const slot = await jsonRpc<number>(this.rpcUrl, "getSlot", [{ commitment: "finalized" }], this.http);
    const time = await jsonRpc<number | null>(this.rpcUrl, "getBlockTime", [slot], this.http);
    return { chain: "solana", headHeight: slot, headTimeMs: (time ?? Math.floor(Date.now() / 1000)) * 1000, atMs: Date.now() };
  }

  async balance(addresses: string[], mint?: string): Promise<bigint> {
    let sum = 0n;
    for (const a of addresses) {
      if (!mint) sum += BigInt((await jsonRpc<{ value: number }>(this.rpcUrl, "getBalance", [a, { commitment: "finalized" }], this.http)).value);
      else {
        const r = await jsonRpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
          this.rpcUrl, "getTokenAccountsByOwner", [a, { mint }, { encoding: "jsonParsed", commitment: "finalized" }], this.http,
        );
        for (const acc of r.value) sum += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
      }
    }
    return sum;
  }
}
