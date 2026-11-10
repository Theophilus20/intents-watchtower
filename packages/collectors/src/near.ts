/**
 * rpc.mainnet.near.org and rpc.testnet.near.org are retired and answer with rate-limit errors;
 * configs that still name them are sent to FastNEAR's free endpoints.
 */
export const NEAR_RPC = { mainnet: "https://free.rpc.fastnear.com", testnet: "https://test.rpc.fastnear.com" } as const;
export function upgradeNearRpc(url: string): string {
  const u = url.replace(/\/+$/, "");
  if (u === "https://rpc.mainnet.near.org") return NEAR_RPC.mainnet;
  if (u === "https://rpc.testnet.near.org") return NEAR_RPC.testnet;
  return url;
}

import type { ChainObs } from "@watchtower/core";
import { jsonRpc, type HttpOptions } from "./http.ts";

/** UTF-8 text to base64, in Node and in browsers alike (the status page runs this code too). */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Minimal NEAR RPC: view calls and the chain head. */
export class NearRpc {
  readonly rpcUrl: string;
  constructor(rpcUrl = "https://free.rpc.fastnear.com", readonly http: HttpOptions = {}) {
    this.rpcUrl = upgradeNearRpc(rpcUrl);
  }

  async view<T>(contract: string, method: string, args: Record<string, unknown> = {}, blockId?: number): Promise<T> {
    const params: Record<string, unknown> = {
      request_type: "call_function",
      account_id: contract,
      method_name: method,
      args_base64: toBase64(JSON.stringify(args)),
    };
    if (blockId !== undefined) params.block_id = blockId;
    else params.finality = "final";
    const r = await jsonRpc<{ result: number[] }>(this.rpcUrl, "query", params, this.http);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
  }

  /** Total minted supply of a NEP-141 bridge token (everything the bridge owes on NEAR). */
  async ftTotalSupply(contract: string, blockId?: number): Promise<bigint> {
    return BigInt(await this.view<string>(contract, "ft_total_supply", {}, blockId));
  }

  /** Balances inside intents.near (NEP-245) for an account. */
  async mtBatchBalanceOf(accountId: string, tokenIds: string[], intents = "intents.near"): Promise<bigint[]> {
    const r = await this.view<string[]>(intents, "mt_batch_balance_of", { account_id: accountId, token_ids: tokenIds });
    return r.map((x) => BigInt(x));
  }

  /** The current shard layout (raw), from the protocol config. */
  async shardLayout(): Promise<unknown> {
    const r = await jsonRpc<{ shard_layout: unknown }>(this.rpcUrl, "EXPERIMENTAL_protocol_config", { finality: "final" }, this.http);
    return r.shard_layout;
  }

  async head(): Promise<ChainObs & { hash: string }> {
    const b = await jsonRpc<{ header: { height: number; timestamp_nanosec: string; hash: string } }>(this.rpcUrl, "block", { finality: "final" }, this.http);
    return { chain: "near", headHeight: b.header.height, headTimeMs: Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n), atMs: Date.now(), hash: b.header.hash };
  }
}

/**
 * Tokens the bridge's own accounts hold, which no user is owed: directly on the token contract,
 * and inside the intents contract's ledger (where deposits land, so a bridge account can hold
 * tokens there too). A failed direct read throws; a failed ledger read counts as zero.
 */
export async function bridgeHeld(near: NearRpc, contract: string, accounts: string[], intentsContract = "intents.near"): Promise<{ direct: bigint; insideIntents: bigint }> {
  let direct = 0n;
  let insideIntents = 0n;
  for (const acc of accounts) {
    direct += BigInt(await near.view<string>(contract, "ft_balance_of", { account_id: acc }));
    if (acc === intentsContract) continue;
    // Unreadable counts as nothing: that can only make backing look lower, never hide a hole.
    try {
      insideIntents += BigInt(await near.view<string>(intentsContract, "mt_balance_of", { account_id: acc, token_id: `nep141:${contract}` }));
    } catch {
      /* treat as zero */
    }
  }
  return { direct, insideIntents };
}
