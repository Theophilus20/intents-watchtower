/**
 * Shared domain types for Intents Watchtower.
 *
 * Conventions
 * - All token amounts are bigint in the asset's smallest unit.
 * - All money values used for thresholds are bigint USD cents (deterministic, no floats).
 * - All timestamps are integer milliseconds since the Unix epoch.
 * - Ratios are integer parts-per-million (ppm): 1_000_000 = 100%.
 */

export type Status = "green" | "amber" | "unknown" | "red";

/** Severity order used by worst-of aggregation. Unknown sits between amber and red: it is never safe. */
export const STATUS_RANK: Record<Status, number> = { green: 0, amber: 1, unknown: 2, red: 3 };
export const STATUSES: readonly Status[] = ["green", "amber", "unknown", "red"];

export function worstStatus(...statuses: Status[]): Status {
  let worst: Status = "green";
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  return worst;
}

export type ChainId = string; // "near" | "bitcoin" | "ethereum" | "bsc" | "solana" | "litecoin" | ...
/** Asset key: `${symbol}:${chain}`, e.g. "btc:bitcoin", "usdt:bsc", "usdc:near". */
export type AssetKey = string;
/** Route id: `${srcAsset}->${dstAsset}`, e.g. "btc:bitcoin->usdc:near". */
export type RouteId = string;

export type BridgeKind = "poa" | "omni" | "hot" | "native";

export interface AssetConfig {
  key: AssetKey;
  symbol: string;
  chain: ChainId;
  decimals: number;
  /** Token id inside intents.near, e.g. "nep141:btc.omft.near". Discovered from the 1Click token list when possible. */
  nearTokenId?: string;
  bridge: BridgeKind;
  /** Stablecoins are checked for depeg. */
  stable?: boolean;
  /** Known custody addresses on the home chain (cold + hot). */
  custodyAddresses?: string[];
  /** Subset of custody addresses that pay withdrawals (watched for drains). */
  hotWallets?: string[];
}

export interface ChainConfig {
  id: ChainId;
  name: string;
  /** Typical block interval. */
  blockTimeSec: number;
  /** Seconds without a new block before amber / red. */
  stallAmberSec: number;
  stallRedSec: number;
  /** How long a NEAR credit may legitimately wait for its source-chain deposit to become visible. */
  confirmWindowSec: number;
  /** Reorg depth that is treated as red. */
  reorgRedDepth: number;
  /** Finality lag (blocks) above which the chain is amber. */
  finalityLagAmber?: number;
}

// ---------------------------------------------------------------------------
// Observations: what collectors (live or simulated) feed into the engine.
// ---------------------------------------------------------------------------

/** Total credited supply of an asset on NEAR (inside the bridge token / intents.near). */
export interface SupplyObs {
  asset: AssetKey;
  credited: bigint;
  /** Burned on NEAR but not yet paid out on the home chain: still a liability, still sitting in custody. */
  pendingWithdrawals: bigint;
  atMs: number;
}

/** Sum of balances held in known custody addresses on the home chain. */
export interface CustodyObs {
  asset: AssetKey;
  balance: bigint;
  atMs: number;
}

/** A balance increase on NEAR that claims to come from a home-chain deposit (NEP-245 mt_mint / ft_mint). */
export interface CreditEvent {
  id: string;
  asset: AssetKey;
  amount: bigint;
  account: string;
  nearTx: string;
  atMs: number;
  /** Source-chain tx hash when the bridge records it (memo / msg). Enables exact matching. */
  sourceTxRef?: string;
  /** Home chain as the bridge names it, e.g. "btc:mainnet" (PoA "BRIDGED_FROM" notes). */
  sourceChain?: string;
}

/** A transfer into a custody / deposit address on the home chain. */
export interface DepositEvent {
  id: string;
  asset: AssetKey;
  amount: bigint;
  /** NEAR account the deposit is attributed to, when the deposit address maps to one. */
  account?: string;
  sourceTx: string;
  atMs: number;
}

/** A withdrawal out of NEAR Intents to a home chain. */
export interface WithdrawalEvent {
  id: string;
  asset: AssetKey;
  amount: bigint;
  account: string;
  nearTx: string;
  destChain: ChainId;
  destTx?: string;
  /** Home-chain address the user withdrew to, when the burn memo says (PoA: "WITHDRAW_TO:<address>"). */
  destAddress?: string;
  atMs: number;
}

export interface HotWalletObs {
  asset: AssetKey;
  address: string;
  balance: bigint;
  atMs: number;
}

/** A settled swap: who filled it and how big it was. */
export interface SolverFill {
  id: string;
  route: RouteId;
  solver: string;
  usdCents: bigint;
  atMs: number;
}

export interface ChainObs {
  chain: ChainId;
  headHeight: number;
  headTimeMs: number;
  finalityLagBlocks?: number;
  /** Deepest reorg seen in the recent window. */
  reorgDepth?: number;
  atMs: number;
}

export interface Advisory {
  id: string;
  chain: ChainId;
  severity: "amber" | "red";
  title: string;
  url?: string;
  fromMs: number;
  untilMs?: number;
}

export interface PriceObs {
  asset: AssetKey;
  /** USD price per whole token, in micro-USD (1 USD = 1_000_000). */
  priceMicroUsd: bigint;
  atMs: number;
}

export interface AccountObs {
  account: string;
  createdAtMs: number;
}

/** Prior hourly outflow history so the anomaly baseline does not start cold. */
export interface OutflowHistory {
  asset: AssetKey;
  hourStartMs: number;
  usdCents: bigint;
}

/** One ingestion step. Every field is optional: collectors send whatever changed. */
export interface ObservationBatch {
  asOfMs: number;
  supply?: SupplyObs[];
  custody?: CustodyObs[];
  credits?: CreditEvent[];
  deposits?: DepositEvent[];
  withdrawals?: WithdrawalEvent[];
  hotWallets?: HotWalletObs[];
  fills?: SolverFill[];
  chains?: ChainObs[];
  advisories?: Advisory[];
  prices?: PriceObs[];
  accounts?: AccountObs[];
  outflowHistory?: OutflowHistory[];
  /**
   * Assets whose home-chain deposits this batch observes in full, so credits can be matched to
   * them. Omitted (replays, simulations): every asset. A live watcher always lists them, and an
   * asset it can't see deposits for (a bridge with one deposit address per user) is never judged
   * by the ghost-credit check, which would otherwise call every normal deposit a ghost.
   */
  depositFeeds?: AssetKey[];
  /**
   * Assets with custody addresses configured. Omitted (replays): every asset. An asset left out
   * reads "custody not set up yet" rather than "custody data stale".
   */
  custodyConfigured?: AssetKey[];
  /**
   * Assets whose custody is known but covers only part of what users are owed, with the
   * shortfall measured from history (see PartialBacking). They are never green: the backing
   * check says "partly verified" and goes red when the shortfall grows past its measured range.
   */
  partialBacking?: PartialBacking[];
}

/**
 * A measured, steady shortfall: what users are owed minus what the configured custody holds, in
 * base units, as the custody finder worked it out from the bridge's own NEAR history and the
 * treasury's home-chain history.
 */
export interface PartialBacking {
  asset: AssetKey;
  /** The usual shortfall (median over the measured window). */
  baselineGap: bigint;
  /** Above baseline + smallGap the shortfall counts as raised; a deposit credited before it is swept does this for a while. */
  smallGap: bigint;
  /** Above this the shortfall is past anything history showed: red at once. */
  alarmGap: bigint;
  /** A raised shortfall that lasts longer than this is not a deposit waiting to be swept: red. */
  persistMs: number;
  /** Start of the window the shortfall was measured over (it was already there then). */
  sinceMs: number;
}

// ---------------------------------------------------------------------------
// Engine output
// ---------------------------------------------------------------------------

export type CheckId = "backing" | "ghost" | "anomaly" | "concentration" | "chain" | "depeg";

/** Integer or string metrics only, so reports hash identically on every watcher. */
export type MetricValue = number | string;

export interface Evidence {
  kind: "near_tx" | "source_tx" | "address" | "advisory" | "note";
  ref: string;
  label?: string;
}

export interface ComponentResult {
  check: CheckId;
  /** What was checked: an asset key, chain id or route id. */
  subject: string;
  status: Status;
  penalty: number;
  /** Reason codes, optionally suffixed with ":subject". */
  reasons: string[];
  metrics: Record<string, MetricValue>;
  evidence: Evidence[];
}

export interface RouteVerdict {
  route: RouteId;
  /** Published status after hysteresis. */
  status: Status;
  /** Raw worst-of status this step, before hysteresis. */
  rawStatus: Status;
  score: number;
  reasons: string[];
  /** Chains whose trouble this route inherits. */
  contagion: ChainId[];
  /**
   * Safe size: the most (whole USD) that can move through this route right now without leaning
   * on liquidity that isn't there. 0 = blocked. See packages/engine/src/capacity.ts.
   */
  capacityUsd: number;
  /** What limited the safe size. */
  capacityBasis: "payout" | "solvers" | "default" | "blocked";
  components: ComponentResult[];
  /** sha256 of the canonical verdict: what watchers sign and the contract stores. */
  reportHash: string;
}

export interface EngineReport {
  engineVersion: string;
  asOfMs: number;
  epoch: number;
  inputsDigest: string;
  routes: RouteVerdict[];
  assets: ComponentResult[];
  chains: ComponentResult[];
  /** chain -> routes that inherit its non-green status */
  contagionMap: Record<ChainId, RouteId[]>;
}
