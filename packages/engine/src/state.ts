import type {
  Advisory, AssetKey, ChainId, ChainObs, CreditEvent, CustodyObs, DepositEvent, PartialBacking, PriceObs, RouteId,
  SolverFill, Status, SupplyObs, WithdrawalEvent,
} from "@watchtower/core";
import { decodeJson, encodeJson } from "@watchtower/core";

export interface CreditState {
  ev: CreditEvent;
  matchedDepositId?: string;
  matchedAtMs?: number;
}

export interface DepositState {
  ev: DepositEvent;
  matchedCreditId?: string;
}

export interface RouteMemory {
  published: Status;
  cleanStreak: number;
  sinceMs: number;
  lastEvalMs: number;
}

/**
 * Everything the engine remembers between steps. Plain data, serialisable with encodeJson,
 * so a watcher can restart without losing baselines, open ghost credits or hysteresis.
 */
export interface EngineState {
  version: 1;
  lastAsOfMs: number;
  inputsDigest: string;
  supply: Record<AssetKey, SupplyObs>;
  custody: Record<AssetKey, CustodyObs>;
  prices: Record<AssetKey, PriceObs>;
  chains: Record<ChainId, ChainObs>;
  advisories: Record<string, Advisory>;
  /** account -> creation time, when a collector knows it */
  accounts: Record<string, number>;
  /** account -> first time the engine saw it (only trusted once we have watched longer than the fresh-account window) */
  firstSeen: Record<string, number>;
  firstIngestMs: number;
  credits: CreditState[];
  deposits: DepositState[];
  withdrawals: WithdrawalEvent[];
  fills: SolverFill[];
  /** `${asset}|${address}` -> recent balance series */
  hotWallets: Record<string, { atMs: number; balance: bigint }[]>;
  /** asset -> hourStartMs -> outflow cents */
  outflowHourly: Record<AssetKey, Record<string, bigint>>;
  /** asset -> first hour we have outflow data for (baseline length) */
  outflowSinceMs: Record<AssetKey, number>;
  backingHistory: Record<AssetKey, { atMs: number; ppm: number }[]>;
  routes: Record<RouteId, RouteMemory>;
  /** asset -> last batch that observed its deposits in full (see ObservationBatch.depositFeeds) */
  depositFeeds?: Record<AssetKey, number>;
  /** True once any batch declared its deposit feeds; until then every asset counts as observed. */
  depositFeedsDeclared?: boolean;
  /** Assets with custody addresses configured, as last declared by a batch (undefined: all). */
  custodyConfigured?: AssetKey[];
  /** Assets whose custody covers a measured part of what is owed (see ObservationBatch.partialBacking). */
  partialBacking?: Record<AssetKey, PartialBacking>;
  /** asset -> when its shortfall first rose above baseline + smallGap, while it stays raised. */
  gapRaisedSince?: Record<AssetKey, number>;
}

export const GENESIS_DIGEST = "0".repeat(64);

export function emptyState(): EngineState {
  return {
    version: 1,
    lastAsOfMs: 0,
    inputsDigest: GENESIS_DIGEST,
    supply: {},
    custody: {},
    prices: {},
    chains: {},
    advisories: {},
    accounts: {},
    firstSeen: {},
    firstIngestMs: 0,
    credits: [],
    deposits: [],
    withdrawals: [],
    fills: [],
    hotWallets: {},
    outflowHourly: {},
    outflowSinceMs: {},
    backingHistory: {},
    routes: {},
  };
}

export function serializeState(s: EngineState): string {
  return encodeJson(s);
}

export function deserializeState(text: string): EngineState {
  const s = decodeJson<EngineState>(text);
  if (s.version !== 1) throw new Error(`Unsupported engine state version ${String((s as { version?: unknown }).version)}`);
  return s;
}
