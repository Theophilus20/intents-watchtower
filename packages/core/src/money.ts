/** Deterministic integer money math. No floats touch anything that gets hashed. */

export const PPM = 1_000_000n;
export const MICRO_USD = 1_000_000n;

export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0 || n > 77) throw new Error(`pow10: bad exponent ${n}`);
  return 10n ** BigInt(n);
}

/** Smallest-unit amount -> USD cents, given a price in micro-USD per whole token. Rounds down. */
export function toUsdCents(amount: bigint, decimals: number, priceMicroUsd: bigint): bigint {
  // amount / 10^dec * price / 1e6 * 100 = amount * price / (10^dec * 1e4)
  return (amount * priceMicroUsd) / (pow10(decimals) * 10_000n);
}

/** USD cents -> smallest-unit amount at a price. Rounds down. */
export function fromUsdCents(cents: bigint, decimals: number, priceMicroUsd: bigint): bigint {
  if (priceMicroUsd <= 0n) return 0n;
  return (cents * pow10(decimals) * 10_000n) / priceMicroUsd;
}

/** Integer ratio in parts-per-million. Returns null when the denominator is zero. */
export function ratioPpm(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  const ppm = (numerator * PPM) / denominator;
  // Clamp to keep the value a safe integer for hashing (10,000,000% is already absurd).
  return Number(ppm > 100_000_000_000n ? 100_000_000_000n : ppm);
}

/** Parse "1.5" into 1500000 for 6 decimals. Throws on precision loss. */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`parseUnits: invalid number "${value}"`);
  const [, neg, whole, frac = ""] = m;
  if (frac.length > decimals) {
    if (/[1-9]/.test(frac.slice(decimals))) throw new Error(`parseUnits: "${value}" has more than ${decimals} decimals`);
  }
  const units = BigInt(whole!) * pow10(decimals) + BigInt((frac.slice(0, decimals) || "0").padEnd(decimals, "0") || "0");
  return neg ? -units : units;
}

/** Format smallest units as a decimal string, trimming trailing zeros, at most `maxFrac` fraction digits. */
export function formatUnits(amount: bigint, decimals: number, maxFrac = decimals): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = pow10(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

/** "$3,812,450" style formatting for display only. */
export function formatUsdCents(cents: bigint, opts: { compact?: boolean } = {}): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const dollars = Number(abs) / 100;
  let s: string;
  if (opts.compact && dollars >= 1_000_000) s = `$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 1 : 2)}M`;
  else if (opts.compact && dollars >= 10_000) s = `$${(dollars / 1000).toFixed(dollars >= 100_000 ? 0 : 1)}K`;
  else s = `$${dollars.toLocaleString("en-US", { maximumFractionDigits: dollars >= 1000 ? 0 : 2 })}`;
  return neg ? `-${s}` : s;
}

export function formatPpmPercent(ppm: number, fractionDigits = 2): string {
  return `${(ppm / 10_000).toFixed(fractionDigits)}%`;
}

export function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

export function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
