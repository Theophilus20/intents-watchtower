import type { Lang } from "@watchtower/explainer";
import { STRINGS } from "./strings.ts";

/**
 * Interface translations.
 *
 *   t("Check a swap before you send it")          the English text is the key
 *   t("{n} routes are unsafe right now", { n })    {name} placeholders are filled in after translating
 *   k("Safe")                                      marks a string in a constant table so the test finds it
 *
 * Every key used in the app must exist in strings.ts for every language; test/i18n.test.ts checks.
 * Missing keys fall back to English rather than breaking the page.
 */

export const LANG_OPTIONS: { id: Lang; label: string; html: string }[] = [
  { id: "en", label: "English", html: "en" },
  { id: "zh", label: "简体中文", html: "zh-CN" },
  { id: "ja", label: "日本語", html: "ja" },
  { id: "ko", label: "한국어", html: "ko" },
  { id: "es", label: "Español", html: "es" },
  { id: "fr", label: "Français", html: "fr" },
  { id: "pt", label: "Português", html: "pt-BR" },
  { id: "de", label: "Deutsch", html: "de" },
  { id: "ru", label: "Русский", html: "ru" },
  { id: "tr", label: "Türkçe", html: "tr" },
  { id: "vi", label: "Tiếng Việt", html: "vi" },
];

export const EVENT_KEYS_NOTE = "event lines with amounts are matched by EVENT_PATTERNS";
export const isLang = (x: unknown): x is Lang => LANG_OPTIONS.some((l) => l.id === x);

let current: Lang = "en";

export function setLang(l: Lang): void {
  current = l;
  if (typeof document !== "undefined") document.documentElement.lang = LANG_OPTIONS.find((o) => o.id === l)?.html ?? "en";
}

export function getLang(): Lang {
  return current;
}

export function t(en: string, vars?: Record<string, string | number>): string {
  const tr = current === "en" ? en : STRINGS[en]?.[current] ?? en;
  return vars ? tr.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m)) : tr;
}

/** Identity: marks a string literal as translatable where it is defined, translated later with t(). */
export const k = (en: string): string => en;

/** Replay event lines that carry amounts are translated by pattern, keeping the amounts. */
const EVENT_PATTERNS: [RegExp, string][] = [
  [/^Ghost credit: (.+) appears on NEAR with no BSC deposit$/, k("Ghost credit: {what} appears on NEAR with no BSC deposit")],
  [/^Long-standing account withdraws (.+) of ETH$/, k("Long-standing account withdraws {what} of ETH")],
];

export function tEvent(label: string): string {
  if (STRINGS[label]) return t(label);
  for (const [re, key] of EVENT_PATTERNS) {
    const m = re.exec(label);
    if (m) return t(key, { what: m[1]! });
  }
  return t(label);
}

/** "5 min", "1 h 30 min" in the current language. */
export function span(min: number): string {
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60;
  if (!h) return t("{m} min", { m });
  return m ? t("{h} h {m} min", { h, m }) : t("{h} h", { h });
}

/** Join sentences: a space between them, except in Chinese and Japanese. */
export function sentences(...parts: (string | false | null | undefined)[]): string {
  const sep = current === "zh" || current === "ja" ? "" : " ";
  return parts.filter((p): p is string => !!p && p.length > 0).join(sep);
}

/**
 * Like t(), but placeholders can be filled with elements (bold numbers, code). Returns an array
 * a component can render, e.g. bold numbers inside a translated sentence.
 */
export function tj<T>(en: string, vars: Record<string, T | string | number>): (T | string)[] {
  const tr = current === "en" ? en : STRINGS[en]?.[current] ?? en;
  const out: (T | string)[] = [];
  let last = 0;
  for (const m of tr.matchAll(/\{(\w+)\}/g)) {
    if (m.index! > last) out.push(tr.slice(last, m.index));
    const v = vars[m[1]!];
    out.push(v === undefined ? m[0] : typeof v === "number" ? String(v) : (v as T | string));
    last = m.index! + m[0].length;
  }
  if (last < tr.length) out.push(tr.slice(last));
  return out;
}

/** Rough display width: CJK and other wide characters count about twice. */
export function textUnits(s: string): number {
  let n = 0;
  for (const ch of s) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 1.85 : 1;
  return n;
}
