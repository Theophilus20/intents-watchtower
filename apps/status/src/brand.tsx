/**
 * Brand slots. Everything you will want to swap for your own identity lives here.
 *
 * LOGO: the built-in mark is <Mark/> below (files in apps/status/public/brand/). To use your own,
 * paste SVG markup into LOGO_SVG (it inherits the text colour via currentColor), or put an image
 * in apps/status/public/ and set LOGO_SRC to its file name, then rebuild.
 *
 * TOKEN ICONS: put official icon files in apps/status/public/tokens/ named by ticker
 * (btc.png, eth.svg, usdc.svg, ...). The build embeds every file it finds there, so icons work
 * offline and inside embedded previews. Tokens without a file show a ticker badge.
 */
import { useState } from "preact/hooks";

export const PRODUCT_NAME = "Intents Watchtower";
export const SHORT_NAME = "Watchtower";
export const LOGO_SVG = "";
export const LOGO_SRC = "";
/** Filled in at build time from apps/status/public/tokens (ticker -> data URI). */
declare const __TOKEN_ICONS__: Record<string, string> | undefined;
export const TOKEN_ICONS: Record<string, string> = typeof __TOKEN_ICONS__ === "object" && __TOKEN_ICONS__ ? __TOKEN_ICONS__ : {};
export const TOKEN_COLORS: Record<string, [string, string]> = {
  btc: ["#f7931a", "#fff"], eth: ["#627eea", "#fff"], usdc: ["#2775ca", "#fff"], usdt: ["#26a17b", "#fff"], sol: ["#7b4ae0", "#fff"], bnb: ["#f0b90b", "#1d1d1d"], ltc: ["#345d9d", "#fff"], near: ["#1c1c1c", "#fff"],
};
/** The native token that represents each chain on the map. */
export const CHAIN_TOKEN: Record<string, string> = { bitcoin: "btc", ethereum: "eth", bsc: "bnb", solana: "sol", litecoin: "ltc", near: "near" };

/**
 * The Watchtower mark: a lookout tower whose lit window is the watch light. Structure follows the
 * text colour; the window is the signal amber. Below 20px the cross brace becomes one bar so it
 * stays crisp.
 */
export function Mark({ size = 26, class: cls = "" }: { size?: number; class?: string }) {
  const small = size < 20;
  return (
    <svg class={`mark ${cls}`} width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M13.6 15.4 24 7.6l10.4 7.8Z" fill="currentColor" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" />
      <rect x="15" y="15.4" width="18" height="11.2" rx="2.2" fill="currentColor" />
      <rect class="mark-window" x="18.2" y="18.6" width="11.6" height="4.8" rx="1.4" />
      <path d="M18.2 26.6 13.4 41.6M29.8 26.6l4.8 15" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" />
      {small
        ? <path d="M15.6 34.2h16.8" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
        : <path d="M16.4 31.4 33 38.2M31.6 31.4 15 38.2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />}
    </svg>
  );
}

export function Brand({ compact }: { compact?: boolean }) {
  return (
    <span class="brand-inner">
      {LOGO_SVG ? <span class="brand-logo" dangerouslySetInnerHTML={{ __html: LOGO_SVG }} /> : LOGO_SRC ? <img class="brand-logo" src={LOGO_SRC} alt="" /> : <Mark size={26} class="brand-mark" />}
      <span class="brand-name">{compact ? SHORT_NAME : PRODUCT_NAME}</span>
    </span>
  );
}

/** A token badge: the official icon when one is supplied, otherwise the ticker on its brand colour. */
export function Token({ symbol, size = 26 }: { symbol: string; size?: number }) {
  const sym = symbol.toLowerCase();
  const [failed, setFailed] = useState(false);
  const icon = TOKEN_ICONS[sym];
  if (icon && !failed) {
    return <img class="token token-img" src={icon} width={size} height={size} alt="" onError={() => setFailed(true)} />;
  }
  const [bg, fg] = TOKEN_COLORS[sym] ?? ["var(--ink-3)", "#fff"];
  const text = sym.toUpperCase();
  return (
    <span class="token" style={{ width: size, height: size, background: bg, color: fg, fontSize: size * (text.length > 3 ? 0.28 : 0.32), letterSpacing: "-0.02em" }} aria-hidden="true">
      {text}
    </span>
  );
}

/** SVG version for the chain map: an embedded icon, or a ticker disc. Centred on (0, 0). */
export function TokenGlyph({ symbol, r = 12 }: { symbol: string; r?: number }) {
  const sym = symbol.toLowerCase();
  const icon = TOKEN_ICONS[sym];
  if (icon) return <image href={icon} x={-r} y={-r} width={r * 2} height={r * 2} />;
  const [bg, fg] = TOKEN_COLORS[sym] ?? ["#7b8594", "#fff"];
  const text = sym.toUpperCase();
  return (
    <g>
      <circle r={r} fill={bg} />
      <text y={r * 0.3} text-anchor="middle" fill={fg} style={{ font: `700 ${r * (text.length > 3 ? 0.56 : 0.66)}px var(--font)`, letterSpacing: "-0.02em" }}>{text}</text>
    </g>
  );
}
