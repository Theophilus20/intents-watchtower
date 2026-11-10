import type { CheckId, Status } from "./types.ts";

export interface ReasonInfo {
  check: CheckId | "engine";
  /** Default status this reason implies when it fires on its own. "info" never changes status. */
  severity: Status | "info";
  title: string;
  /** One sentence a non-engineer can understand. */
  plain: string;
}

/**
 * The closed set of reason codes. Reasons attached to a route may carry a subject suffix,
 * e.g. "GHOST_CREDIT:usdt:bsc" or "CHAIN_ADVISORY:litecoin".
 */
export const REASONS = {
  // Check 1: proof of backing
  BACKING_BELOW_THRESHOLD: { check: "backing", severity: "red", title: "Backing below 99.5%", plain: "Less money is held on the home chain than has been credited on NEAR." },
  BACKING_TOLERANCE: { check: "backing", severity: "amber", title: "Backing inside tolerance band", plain: "Backing is a hair under 100%, which can happen while transfers settle." },
  BACKING_DROP_FAST: { check: "backing", severity: "amber", title: "Backing falling fast", plain: "The backing ratio dropped sharply in the last few minutes." },
  CUSTODY_NOT_CONFIGURED: { check: "backing", severity: "unknown", title: "Custody not set up yet", plain: "Watchtower doesn't know yet where the bridge keeps this asset, so it can't prove the backing." },
  BACKING_PARTIAL: { check: "backing", severity: "unknown", title: "Partly verified", plain: "Watchtower found the bridge's treasury, but it holds only part of what users are owed. It can't prove the rest, and raises an alarm if the missing part grows." },
  BACKING_GAP_GROWN: { check: "backing", severity: "red", title: "Shortfall growing", plain: "The bridge's treasury is missing more than usual: the shortfall grew past the range seen in its history." },
  CUSTODY_DATA_STALE: { check: "backing", severity: "unknown", title: "Custody data stale", plain: "We could not read home-chain custody balances recently, so we cannot vouch for this asset." },
  SUPPLY_DATA_STALE: { check: "backing", severity: "unknown", title: "NEAR supply data stale", plain: "We could not read the credited supply on NEAR recently." },
  // Check 2: ghost credits
  GHOST_CREDIT: { check: "ghost", severity: "red", title: "Credit with no deposit", plain: "Tokens were credited on NEAR but no matching deposit ever arrived on the home chain." },
  GHOST_CREDIT_PENDING: { check: "ghost", severity: "amber", title: "Large credit awaiting its deposit", plain: "A large credit has not been matched to a home-chain deposit yet." },
  GHOST_UNCHECKED: { check: "ghost", severity: "info", title: "Deposits not matched", plain: "This bridge gives each user a separate deposit address, so Watchtower can't match credits to deposits yet. The backing check still catches tokens minted without coins behind them." },
  GHOST_CREDIT_WITHDRAWN: { check: "ghost", severity: "red", title: "Unbacked credit is being withdrawn", plain: "An account credited with no matching deposit is already moving the money out." },
  // Check 3: flow anomalies
  OUTFLOW_SPIKE: { check: "anomaly", severity: "amber", title: "Withdrawals far above normal", plain: "Withdrawals in the last hour are far above this asset's normal level." },
  HOT_WALLET_DRAIN: { check: "anomaly", severity: "amber", title: "Hot wallet draining", plain: "A bridge hot wallet lost a large share of its balance in minutes." },
  FRESH_ACCOUNT_EXIT: { check: "anomaly", severity: "amber", title: "New accounts withdrawing large amounts", plain: "Very new accounts are withdrawing unusually large amounts." },
  MINT_THEN_EXIT: { check: "anomaly", severity: "amber", title: "Credited then withdrawn within minutes", plain: "Money was credited and pulled out to another chain within minutes at unusual size." },
  BASELINE_WARMING: { check: "anomaly", severity: "info", title: "Baseline still warming up", plain: "Not enough history yet to judge what normal outflow looks like." },
  // Check 4: solver concentration
  SOLVER_CONCENTRATED: { check: "concentration", severity: "amber", title: "Liquidity concentrated", plain: "A small number of solvers fill most of this route." },
  SINGLE_SOLVER_ROUTE: { check: "concentration", severity: "red", title: "One solver deep", plain: "One solver fills nearly all of this route; if it leaves, the route breaks." },
  THIN_DEPTH: { check: "concentration", severity: "amber", title: "Thin depth", plain: "Quotes at your size move the price a lot." },
  LOW_ACTIVITY: { check: "concentration", severity: "info", title: "Low activity", plain: "Too few fills in the last 24 hours to measure competition." },
  // Check 5: chain health and contagion
  CHAIN_STALLED: { check: "chain", severity: "red", title: "Chain stalled", plain: "A chain this route depends on has stopped producing blocks." },
  CHAIN_SLOW: { check: "chain", severity: "amber", title: "Chain slow", plain: "A chain this route depends on is producing blocks much slower than normal." },
  CHAIN_REORG: { check: "chain", severity: "red", title: "Deep reorganisation", plain: "A chain this route depends on rewrote recent history." },
  CHAIN_FINALITY_DELAY: { check: "chain", severity: "amber", title: "Finality delayed", plain: "Transactions on a dependent chain are taking longer than normal to become final." },
  CHAIN_ADVISORY: { check: "chain", severity: "red", title: "Security advisory", plain: "A security advisory is active for a chain this route depends on." },
  CHAIN_DATA_STALE: { check: "chain", severity: "unknown", title: "Chain data stale", plain: "We could not read this chain recently." },
  ASSET_DEPEG: { check: "depeg", severity: "red", title: "Stablecoin depeg", plain: "A stablecoin on this route is trading away from $1." },
  ASSET_DEPEG_MINOR: { check: "depeg", severity: "amber", title: "Stablecoin drifting", plain: "A stablecoin on this route has drifted slightly from $1." },
  PRICE_DATA_STALE: { check: "depeg", severity: "unknown", title: "Price data stale", plain: "We could not read a recent price for this asset." },
  // Engine
  NO_DATA: { check: "engine", severity: "unknown", title: "No data", plain: "The engine has not received the data it needs for this route." },
  HYSTERESIS_HOLD: { check: "engine", severity: "info", title: "Recovering", plain: "Checks look clean again; the route stays cautious until several clean checks in a row." },
} as const satisfies Record<string, ReasonInfo>;

export type ReasonCode = keyof typeof REASONS;

export function reasonCode(reason: string): ReasonCode | undefined {
  const code = reason.split(":")[0]!;
  return code in REASONS ? (code as ReasonCode) : undefined;
}

export function reasonSubject(reason: string): string | undefined {
  const i = reason.indexOf(":");
  return i === -1 ? undefined : reason.slice(i + 1);
}

export function withSubject(code: ReasonCode, subject?: string): string {
  return subject ? `${code}:${subject}` : code;
}

export function describeReason(reason: string): ReasonInfo & { code: string; subject?: string } {
  const code = reasonCode(reason);
  const subject = reasonSubject(reason);
  if (!code) return { code: reason, subject, check: "engine", severity: "info", title: reason, plain: reason };
  return { code, subject, ...REASONS[code] };
}
