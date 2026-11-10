import { DEFAULT_ASSETS, parseRoute } from "@watchtower/core";

/**
 * Turn whatever an agent or a person typed into an asset key ("usdt:bsc").
 *
 *   "usdt:bsc", "USDT on BSC", "usdt (BNB Chain)", "btc", "NEAR"   all work
 *   "usdc"                                                         is ambiguous: we say which chains exist
 */

export const CHAIN_NAMES: Record<string, string> = {
  bitcoin: "Bitcoin",
  ethereum: "Ethereum",
  bsc: "BNB Chain",
  solana: "Solana",
  litecoin: "Litecoin",
  near: "NEAR",
};

const CHAIN_ALIASES: Record<string, string> = {
  bitcoin: "bitcoin", btc: "bitcoin",
  ethereum: "ethereum", eth: "ethereum", "ethereum mainnet": "ethereum", mainnet: "ethereum",
  bsc: "bsc", "bnb chain": "bsc", "bnb smart chain": "bsc", "binance smart chain": "bsc", bnb: "bsc", binance: "bsc", bep20: "bsc",
  solana: "solana", sol: "solana",
  litecoin: "litecoin", ltc: "litecoin",
  near: "near", "near protocol": "near",
};

const FILLER = new Set(["on", "via", "from", "to", "the", "network", "chain"]);

export function assetLabel(key: string): string {
  const [sym, chain] = key.split(":");
  // The native token of its own chain reads better on its own: "NEAR", not "NEAR on NEAR".
  if (sym === chain) return (sym ?? key).toUpperCase();
  return `${(sym ?? key).toUpperCase()} on ${CHAIN_NAMES[chain ?? ""] ?? chain}`;
}

export function routeLabel(route: string): string {
  const r = parseRoute(route);
  return `${assetLabel(r.src)} → ${assetLabel(r.dst)}`;
}

export class AssetError extends Error {}

/** Every asset we can name: the default catalog plus anything that appears in known routes. */
export function assetCatalog(routes: string[] = []): string[] {
  const keys = new Set(DEFAULT_ASSETS.map((a) => a.key));
  for (const r of routes) {
    try {
      const p = parseRoute(r);
      keys.add(p.src);
      keys.add(p.dst);
    } catch {
      /* ignore unparseable */
    }
  }
  return [...keys].sort();
}

export function resolveAsset(input: unknown, catalog: string[]): string {
  if (typeof input !== "string" || !input.trim()) throw new AssetError("Name a token, e.g. \"usdt:bsc\" or \"BTC on Bitcoin\".");
  const raw = input.trim().toLowerCase();
  if (/^[a-z0-9]{1,16}:[a-z0-9]{1,16}$/.test(raw)) {
    const [sym, chainWord] = raw.split(":") as [string, string];
    return `${sym}:${CHAIN_ALIASES[chainWord] ?? chainWord}`;
  }
  const words = raw.replace(/[(),]/g, " ").split(/[\s./_-]+/).filter((w) => w && !FILLER.has(w));
  const [sym, ...rest] = words;
  if (!sym) throw new AssetError(`Could not read a token from "${input}".`);
  const chainPhrase = rest.join(" ");
  if (chainPhrase) {
    const chain = CHAIN_ALIASES[chainPhrase] ?? CHAIN_ALIASES[rest[0]!];
    if (!chain) throw new AssetError(`Unknown chain "${chainPhrase}". Known chains: ${Object.values(CHAIN_NAMES).join(", ")}.`);
    return `${sym}:${chain}`;
  }
  const matches = catalog.filter((k) => k.startsWith(`${sym}:`));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new AssetError(`${sym.toUpperCase()} exists on several chains: ${matches.map(assetLabel).join(", ")}. Say which one, e.g. "${matches[0]}".`);
  throw new AssetError(`Unknown token "${input}". Known: ${catalog.map((k) => k).join(", ")}.`);
}
