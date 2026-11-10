import type { AssetKey, ChainId, ComponentResult } from "@watchtower/core";
import { withSubject, worstStatus } from "@watchtower/core";
import { component, type Ctx } from "../context.ts";

/** Check 5a: chain health — stalls, reorgs, finality delays and security advisories. */
export function checkChain(ctx: Ctx, chain: ChainId): ComponentResult {
  const c = component("chain", chain);
  const { cfg, state, asOfMs } = ctx;
  const conf = ctx.chains.get(chain);
  const obs = state.chains[chain];

  // Advisories apply even if we cannot reach the chain.
  for (const adv of Object.values(state.advisories).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (adv.chain !== chain || adv.fromMs > asOfMs || (adv.untilMs !== undefined && adv.untilMs <= asOfMs)) continue;
    c.status = worstStatus(c.status, adv.severity);
    c.reasons.push(withSubject("CHAIN_ADVISORY", chain));
    c.evidence.push({ kind: "advisory", ref: adv.url ?? adv.id, label: adv.title });
    c.penalty = Math.max(c.penalty, adv.severity === "red" ? cfg.scorer.caps.chain : 12);
  }

  if (!conf || !obs || asOfMs - obs.atMs > cfg.freshness.chainMs) {
    c.status = worstStatus(c.status, "unknown");
    c.reasons.push(withSubject("CHAIN_DATA_STALE", chain));
    c.penalty = Math.max(c.penalty, 15);
    return finish(c);
  }

  // How old the head was when we read it. Measuring against now instead would turn our own missed
  // readings (a slow round, a dropped connection) into a false "chain stopped" alarm.
  const sinceBlock = Math.max(0, Math.floor((obs.atMs - obs.headTimeMs) / 1000));
  c.metrics.head_height = obs.headHeight;
  c.metrics.seconds_since_block = sinceBlock;
  if (sinceBlock >= conf.stallRedSec) {
    c.status = worstStatus(c.status, "red");
    c.reasons.push(withSubject("CHAIN_STALLED", chain));
    c.penalty = Math.max(c.penalty, cfg.scorer.caps.chain);
  } else if (sinceBlock >= conf.stallAmberSec) {
    c.status = worstStatus(c.status, "amber");
    c.reasons.push(withSubject("CHAIN_SLOW", chain));
    c.penalty = Math.max(c.penalty, 10);
  }

  const reorg = obs.reorgDepth ?? 0;
  c.metrics.reorg_depth = reorg;
  if (reorg >= conf.reorgRedDepth) {
    c.status = worstStatus(c.status, "red");
    c.reasons.push(withSubject("CHAIN_REORG", chain));
    c.penalty = Math.max(c.penalty, cfg.scorer.caps.chain);
  }

  if (conf.finalityLagAmber !== undefined && obs.finalityLagBlocks !== undefined) {
    c.metrics.finality_lag_blocks = obs.finalityLagBlocks;
    if (obs.finalityLagBlocks > conf.finalityLagAmber) {
      c.status = worstStatus(c.status, "amber");
      c.reasons.push(withSubject("CHAIN_FINALITY_DELAY", chain));
      c.penalty = Math.max(c.penalty, 10);
    }
  }
  return finish(c);
}

/** Check 5b: stablecoin depeg. */
export function checkDepeg(ctx: Ctx, asset: AssetKey): ComponentResult {
  const c = component("depeg", asset);
  const { cfg, state, asOfMs } = ctx;
  const p = state.prices[asset];
  if (!p || asOfMs - p.atMs > cfg.freshness.priceMs) {
    c.status = "unknown";
    c.reasons.push(withSubject("PRICE_DATA_STALE", asset));
    c.penalty = 10;
    return c;
  }
  const dev = Number(p.priceMicroUsd > 1_000_000n ? p.priceMicroUsd - 1_000_000n : 1_000_000n - p.priceMicroUsd);
  c.metrics.price_micro_usd = p.priceMicroUsd.toString();
  c.metrics.deviation_ppm = dev;
  if (dev >= cfg.depeg.redPpm) {
    c.status = "red";
    c.reasons.push(withSubject("ASSET_DEPEG", asset));
    c.penalty = cfg.scorer.caps.chain;
  } else if (dev >= cfg.depeg.amberPpm) {
    c.status = "amber";
    c.reasons.push(withSubject("ASSET_DEPEG_MINOR", asset));
    c.penalty = 10;
  }
  return c;
}

function finish(c: ComponentResult): ComponentResult {
  c.reasons = [...new Set(c.reasons)];
  return c;
}
