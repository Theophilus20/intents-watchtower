import type { AssetConfig, AssetKey, ChainConfig, ChainId, ComponentResult, Status } from "@watchtower/core";
import { indexBy, toUsdCents } from "@watchtower/core";
import type { EngineConfig } from "./config.ts";
import type { EngineState } from "./state.ts";

export interface Ctx {
  cfg: EngineConfig;
  state: EngineState;
  asOfMs: number;
  assets: Map<AssetKey, AssetConfig>;
  chains: Map<ChainId, ChainConfig>;
}

export function makeCtx(cfg: EngineConfig, state: EngineState, asOfMs: number): Ctx {
  return { cfg, state, asOfMs, assets: indexBy(cfg.assets, (a) => a.key), chains: indexBy(cfg.chains, (c) => c.id) };
}

/** USD cents for an amount of an asset at the latest known price; 0 when no price is known. */
export function usd(ctx: Ctx, asset: AssetKey, amount: bigint): bigint {
  const a = ctx.assets.get(asset);
  const p = ctx.state.prices[asset];
  if (!a || !p) return 0n;
  return toUsdCents(amount, a.decimals, p.priceMicroUsd);
}

export function component(check: ComponentResult["check"], subject: string, status: Status = "green"): ComponentResult {
  return { check, subject, status, penalty: 0, reasons: [], metrics: {}, evidence: [] };
}

export function chainOf(ctx: Ctx, asset: AssetKey): ChainConfig | undefined {
  const a = ctx.assets.get(asset);
  return a ? ctx.chains.get(a.chain) : undefined;
}

export function isBridged(ctx: Ctx, asset: AssetKey): boolean {
  const a = ctx.assets.get(asset);
  return !!a && a.bridge !== "native";
}
