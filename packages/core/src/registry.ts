import type { AssetConfig, ChainConfig, RouteId } from "./types.ts";

/**
 * Default chain parameters. Stall thresholds respect each chain's block-time variance:
 * Bitcoin blocks are Poisson(10 min), so 60 minutes without a block happens a few times a
 * month and must not page anyone; NEAR blocks arrive every second, so 2 minutes is a stall.
 */
export const DEFAULT_CHAINS: ChainConfig[] = [
  { id: "near", name: "NEAR", blockTimeSec: 1, stallAmberSec: 30, stallRedSec: 120, confirmWindowSec: 120, reorgRedDepth: 1 },
  { id: "bitcoin", name: "Bitcoin", blockTimeSec: 600, stallAmberSec: 3_600, stallRedSec: 7_200, confirmWindowSec: 1_800, reorgRedDepth: 2 },
  { id: "ethereum", name: "Ethereum", blockTimeSec: 12, stallAmberSec: 120, stallRedSec: 600, confirmWindowSec: 600, reorgRedDepth: 3, finalityLagAmber: 96 },
  { id: "bsc", name: "BNB Chain", blockTimeSec: 1, stallAmberSec: 60, stallRedSec: 300, confirmWindowSec: 300, reorgRedDepth: 4 },
  { id: "solana", name: "Solana", blockTimeSec: 1, stallAmberSec: 60, stallRedSec: 300, confirmWindowSec: 300, reorgRedDepth: 32 },
  { id: "litecoin", name: "Litecoin", blockTimeSec: 150, stallAmberSec: 1_500, stallRedSec: 3_600, confirmWindowSec: 1_200, reorgRedDepth: 3 },
];

/**
 * Default asset set for the MVP. `nearTokenId` values marked here are the ones documented in
 * NEAR Intents docs/examples; everything else is discovered at runtime from the 1Click token
 * list (GET https://1click.chaindefuser.com/v0/tokens), so nothing has to be hard-coded.
 * Custody and hot-wallet addresses are deployment config (see config/watchtower.example.json).
 */
export const DEFAULT_ASSETS: AssetConfig[] = [
  { key: "btc:bitcoin", symbol: "btc", chain: "bitcoin", decimals: 8, bridge: "poa", nearTokenId: "nep141:btc.omft.near" },
  { key: "eth:ethereum", symbol: "eth", chain: "ethereum", decimals: 18, bridge: "poa", nearTokenId: "nep141:eth.omft.near" },
  { key: "usdc:ethereum", symbol: "usdc", chain: "ethereum", decimals: 6, bridge: "poa", stable: true, nearTokenId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near" },
  { key: "sol:solana", symbol: "sol", chain: "solana", decimals: 9, bridge: "poa", nearTokenId: "nep141:sol.omft.near" },
  { key: "usdt:bsc", symbol: "usdt", chain: "bsc", decimals: 18, bridge: "hot", stable: true },
  { key: "bnb:bsc", symbol: "bnb", chain: "bsc", decimals: 18, bridge: "hot" },
  { key: "ltc:litecoin", symbol: "ltc", chain: "litecoin", decimals: 8, bridge: "poa" },
  { key: "usdc:near", symbol: "usdc", chain: "near", decimals: 6, bridge: "native", stable: true, nearTokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" },
  { key: "near:near", symbol: "near", chain: "near", decimals: 24, bridge: "native", nearTokenId: "nep141:wrap.near" },
];

export const DEFAULT_ROUTES: RouteId[] = [
  "btc:bitcoin->usdc:near",
  "eth:ethereum->usdc:near",
  "usdc:ethereum->sol:solana",
  "sol:solana->usdc:near",
  "usdt:bsc->usdc:near",
  "bnb:bsc->eth:ethereum",
  "near:near->usdt:bsc",
  "usdc:near->btc:bitcoin",
  "eth:ethereum->sol:solana",
  "usdt:bsc->btc:bitcoin",
  "ltc:litecoin->usdc:near",
  "ltc:litecoin->btc:bitcoin",
];

export function indexBy<T, K extends string>(items: T[], key: (t: T) => K): Map<K, T> {
  return new Map(items.map((i) => [key(i), i]));
}
