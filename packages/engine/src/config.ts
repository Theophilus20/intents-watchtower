import { DEFAULT_ASSETS, DEFAULT_CHAINS, DEFAULT_ROUTES } from "@watchtower/core";
import type { AssetConfig, ChainConfig, RouteId } from "@watchtower/core";

export const ENGINE_VERSION = "1.0.0";

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * Every threshold in one place. Defaults follow the spec in docs/METHODOLOGY.md; anything
 * money-denominated is integer USD cents so watchers compute byte-identical reports.
 */
export interface EngineConfig {
  assets: AssetConfig[];
  chains: ChainConfig[];
  routes: RouteId[];
  /** Engine step: one epoch per step. */
  stepMs: number;

  freshness: {
    supplyMs: number;
    custodyMs: number;
    chainMs: number;
    priceMs: number;
  };

  backing: {
    /** >= green */
    greenPpm: number;
    /** >= amber (tolerance band), below is red */
    amberPpm: number;
    /** A drop of this much within dropWindowMs is "falling fast". */
    dropFastPpm: number;
    /** Above 100%, a fast drop only counts if the cushion left is smaller than this many such drops. */
    cushionDrops: number;
    dropWindowMs: number;
    /**
     * The usual level is also taken over this longer window. A withdrawal burned on NEAR and
     * collected on the home chain much later lifts the ratio for longer than dropWindowMs; when
     * it is collected the ratio returns to where it sat for hours, which is not a fall.
     */
    baselineWindowMs: number;
  };

  ghost: {
    /** How far back a deposit may precede its credit (confirmations, batching). */
    depositLookbackMs: number;
    /** Allowed bridge fee: credit may be this much smaller than the deposit. */
    feeTolPpm: number;
    feeAbsCents: bigint;
    /** Unmatched credits are not judged until this old (observer polling lag). */
    graceMs: number;
    /** If an unmatched credit's account withdraws >= this share of its value, it is being exited. */
    exitFractionPpm: number;
    /** A pending credit at least this large goes amber after grace. */
    pendingAmberCents: bigint;
    /** Ghost credits keep the route red this long unless backing is restored and they are resolved. */
    holdMs: number;
  };

  anomaly: {
    baselineMinHours: number;
    baselineMaxHours: number;
    /** Std-dev floor so a quiet asset doesn't alarm on its first busy hour. */
    sdFloorCents: bigint;
    sdFloorMeanPpm: number;
    zAmber100: number;
    zStrong100: number;
    drainWindowMs: number;
    drainPpm: number;
    drainStrongPpm: number;
    freshAccountMs: number;
    freshMinTxCents: bigint;
    freshSumCents: bigint;
    mintExitWindowMs: number;
    mintExitMinCents: bigint;
    mintExitMatchPpm: number;
  };

  concentration: {
    windowMs: number;
    minFills: number;
    hhiAmber: number;
    hhiRed: number;
    topAmberPpm: number;
    topRedPpm: number;
  };

  depeg: {
    amberPpm: number;
    redPpm: number;
  };

  scorer: {
    /** Consecutive clean steps needed to step down one level (red -> amber -> green). */
    cleanStepsToRecover: number;
    maxReasons: number;
    caps: { backing: number; ghost: number; anomaly: number; concentration: number; chain: number };
  };
}

export function defaultConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  const base: EngineConfig = {
    assets: DEFAULT_ASSETS,
    chains: DEFAULT_CHAINS,
    routes: DEFAULT_ROUTES,
    stepMs: MIN,
    freshness: { supplyMs: 10 * MIN, custodyMs: 10 * MIN, chainMs: 5 * MIN, priceMs: 15 * MIN },
    backing: { greenPpm: 1_000_000, amberPpm: 995_000, dropFastPpm: 2_000, cushionDrops: 5, dropWindowMs: 15 * MIN, baselineWindowMs: 120 * MIN },
    ghost: {
      depositLookbackMs: 6 * HOUR,
      feeTolPpm: 10_000,
      feeAbsCents: 500n,
      graceMs: 3 * MIN,
      exitFractionPpm: 500_000,
      pendingAmberCents: 1_000_000n, // $10k
      holdMs: 24 * HOUR,
    },
    anomaly: {
      baselineMinHours: 24,
      baselineMaxHours: 720,
      sdFloorCents: 1_000_000n, // $10k
      sdFloorMeanPpm: 250_000,
      zAmber100: 400,
      zStrong100: 1_000,
      drainWindowMs: 15 * MIN,
      drainPpm: 300_000,
      drainStrongPpm: 600_000,
      freshAccountMs: 24 * HOUR,
      freshMinTxCents: 1_000_000n, // $10k
      freshSumCents: 5_000_000n, // $50k
      mintExitWindowMs: 10 * MIN,
      mintExitMinCents: 2_500_000n, // $25k
      mintExitMatchPpm: 800_000,
    },
    concentration: { windowMs: 24 * HOUR, minFills: 8, hhiAmber: 1_500, hhiRed: 2_500, topAmberPpm: 400_000, topRedPpm: 700_000 },
    depeg: { amberPpm: 10_000, redPpm: 30_000 },
    scorer: { cleanStepsToRecover: 3, maxReasons: 16, caps: { backing: 40, ghost: 40, anomaly: 25, concentration: 15, chain: 30 } },
  };
  return deepMerge(base, overrides) as EngineConfig;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || a === null || b === null) return b;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
  return out;
}
