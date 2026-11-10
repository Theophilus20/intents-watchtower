import type { AssetConfig, PriceObs } from "@watchtower/core";
import { assetKey } from "@watchtower/core";
import { fetchJson, type HttpOptions } from "./http.ts";

/** GET https://1click.chaindefuser.com/v0/tokens — the canonical list of NEAR Intents assets. */
export interface OneClickToken {
  assetId: string; // e.g. "nep141:btc.omft.near"
  decimals: number;
  blockchain: string; // "btc" | "eth" | "sol" | "near" | "bsc" | ...
  symbol: string;
  price: number | string;
  priceUpdatedAt: string;
  contractAddress?: string;
}

/** 1Click blockchain codes -> Watchtower chain ids. */
export const ONECLICK_CHAINS: Record<string, string> = {
  btc: "bitcoin", eth: "ethereum", sol: "solana", near: "near", bsc: "bsc", ltc: "litecoin", arb: "arbitrum", base: "base",
  pol: "polygon", ton: "ton", op: "optimism", avax: "avalanche", tron: "tron", doge: "dogecoin", xrp: "xrp", stellar: "stellar", zec: "zcash", sui: "sui", aptos: "aptos", cardano: "cardano", gnosis: "gnosis", bera: "berachain",
};

const STABLES = new Set(["usdc", "usdt", "dai", "usde", "pyusd", "fdusd", "usd1"]);

export class OneClickClient {
  constructor(readonly baseUrl = "https://1click.chaindefuser.com", readonly http: HttpOptions = {}) {}

  tokens(): Promise<OneClickToken[]> {
    return fetchJson<OneClickToken[]>(`${this.baseUrl}/v0/tokens`, {}, this.http);
  }
}

/** Turn the 1Click token list into Watchtower assets + prices. Bridge kind is inferred from the token id. */
export function assetsFromTokens(tokens: OneClickToken[]): { assets: AssetConfig[]; prices: PriceObs[]; byTokenId: Map<string, string> } {
  const assets: AssetConfig[] = [];
  const prices: PriceObs[] = [];
  const byTokenId = new Map<string, string>();
  for (const t of tokens) {
    const chain = ONECLICK_CHAINS[t.blockchain] ?? t.blockchain;
    const symbol = t.symbol.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!symbol) continue;
    const key = assetKey(symbol, chain);
    if (byTokenId.has(t.assetId) || assets.some((a) => a.key === key)) continue;
    const bridge = chain === "near" ? "native" : t.assetId.includes(".omft.near") ? "poa" : t.assetId.includes("omni.hot") ? "hot" : "omni";
    assets.push({ key, symbol, chain, decimals: t.decimals, bridge, nearTokenId: t.assetId, stable: STABLES.has(symbol) });
    byTokenId.set(t.assetId, key);
    const price = Number(t.price);
    if (Number.isFinite(price) && price > 0) prices.push({ asset: key, priceMicroUsd: BigInt(Math.round(price * 1e6)), atMs: Date.parse(t.priceUpdatedAt) || Date.now() });
  }
  return { assets, prices, byTokenId };
}
