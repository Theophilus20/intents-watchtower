import { describe, expect, it } from "vitest";
import { LANGS, extractFacts, templateExplain, type Lang } from "@watchtower/explainer";
import { collectKeys } from "../i18n-keys.ts";
import { STRINGS } from "../src/strings.ts";
import { LANG_OPTIONS, setLang, span, t, tEvent } from "../src/i18n.ts";
import { ROW_ORDER } from "../src/strings-row.ts";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

describe("translations", () => {
  const keys = collectKeys();

  it("cover every string the interface can show, in every language", () => {
    const missing: string[] = [];
    for (const key of keys) for (const l of ROW_ORDER) if (!STRINGS[key]?.[l]) missing.push(`${l}: ${key}`);
    expect(missing).toEqual([]);
  });

  it("keep every placeholder", () => {
    const broken: string[] = [];
    for (const [key, row] of Object.entries(STRINGS)) for (const [l, v] of Object.entries(row)) if (v && placeholders(v) !== placeholders(key)) broken.push(`${l}: ${key}`);
    expect(broken).toEqual([]);
  });

  it("offer the same languages in the app and in the explanations", () => {
    expect(LANG_OPTIONS.map((l) => l.id).sort()).toEqual(Object.keys(LANGS).sort());
  });

  it("fill placeholders and translate replay events that carry amounts", () => {
    setLang("ja");
    expect(t("{n} routes are unsafe right now", { n: 3 })).toBe("現在3つのルートが危険です");
    expect(span(90)).toBe("1時間30分");
    expect(tEvent("Ghost credit: $90K USDT appears on NEAR with no BSC deposit")).toBe("架空記帳：BSC への入金なしに $90K USDT が NEAR に出現");
    setLang("en");
    expect(t("{n} routes are unsafe right now", { n: 3 })).toBe("3 routes are unsafe right now");
  });

  it.each(Object.keys(LANGS) as Lang[])("explain a red route in %s with its own sentence endings", (lang) => {
    const text = templateExplain(extractFacts({ route: "usdt:bsc->usdc:near", status: "red", reasons: ["GHOST_CREDIT:usdt:bsc"], components: [] }), lang);
    expect(text.startsWith("🔴")).toBe(true);
    if (lang === "zh" || lang === "ja") expect(text).not.toMatch(/\. /);
  });
});
