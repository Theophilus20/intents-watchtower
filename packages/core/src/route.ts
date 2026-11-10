import type { AssetKey, ChainId, RouteId } from "./types.ts";

const PART = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

export interface ParsedRoute {
  id: RouteId;
  src: AssetKey;
  dst: AssetKey;
  srcSymbol: string;
  srcChain: ChainId;
  dstSymbol: string;
  dstChain: ChainId;
}

export function assetKey(symbol: string, chain: ChainId): AssetKey {
  return `${symbol.toLowerCase()}:${chain.toLowerCase()}`;
}

export function parseAssetKey(key: AssetKey): { symbol: string; chain: ChainId } {
  const parts = key.split(":");
  if (parts.length !== 2 || !PART.test(parts[0]!) || !PART.test(parts[1]!)) {
    throw new Error(`Invalid asset key "${key}". Expected "symbol:chain", e.g. "btc:bitcoin".`);
  }
  return { symbol: parts[0]!, chain: parts[1]! };
}

/**
 * Route ids look like "btc:bitcoin->usdc:near". Whitespace and case are normalised so
 * "BTC:Bitcoin -> USDC:NEAR" and "btc:bitcoin->usdc:near" are the same route.
 */
export function parseRoute(route: string): ParsedRoute {
  const norm = route.replace(/\s+/g, "").toLowerCase();
  const sides = norm.split("->");
  if (sides.length !== 2) throw new Error(`Invalid route "${route}". Expected "src_symbol:src_chain->dst_symbol:dst_chain".`);
  const src = parseAssetKey(sides[0]!);
  const dst = parseAssetKey(sides[1]!);
  const id = `${src.symbol}:${src.chain}->${dst.symbol}:${dst.chain}`;
  if (sides[0] === sides[1]) throw new Error(`Route "${route}" has the same source and destination.`);
  return { id, src: sides[0]!, dst: sides[1]!, srcSymbol: src.symbol, srcChain: src.chain, dstSymbol: dst.symbol, dstChain: dst.chain };
}

export function normalizeRoute(route: string): RouteId {
  return parseRoute(route).id;
}

/** Every chain a route depends on. Settlement always happens on NEAR. */
export function routeChains(route: string): ChainId[] {
  const r = parseRoute(route);
  return [...new Set([r.srcChain, r.dstChain, "near"])].sort();
}

export function routeAssets(route: string): AssetKey[] {
  const r = parseRoute(route);
  return [r.src, r.dst];
}

/** Contract-side validation mirror: ASCII, bounded, no separator characters used by the attestation format. */
export function isValidRouteId(route: string): boolean {
  if (route.length === 0 || route.length > 128) return false;
  if (/[|,\s]/.test(route)) return false;
  try {
    return parseRoute(route).id === route;
  } catch {
    return false;
  }
}
