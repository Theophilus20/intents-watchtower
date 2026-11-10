/**
 * Every English string the status app can show, so translations can be checked for completeness.
 *   npx tsx apps/status/i18n-keys.ts            list missing translations per language
 *   npx tsx apps/status/i18n-keys.ts --keys     print all keys as JSON
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REASONS } from "@watchtower/core";
import { SCENARIOS } from "@watchtower/replay";

const here = dirname(fileURLToPath(import.meta.url));
const EVENT_PATTERNS = [/^Ghost credit: (.+) appears on NEAR with no BSC deposit$/, /^Long-standing account withdraws (.+) of ETH$/];
/** Strings shown through t() on a computed value rather than a literal. */
const EXTRA = ["Replay", "Litecoin client zero-day (simulated)"];

export function collectKeys(): string[] {
  const keys = new Set<string>(EXTRA);
  const src = join(here, "src");
  for (const f of readdirSync(src)) {
    if (!/\.(ts|tsx)$/.test(f) || f === "strings.ts") continue;
    const code = readFileSync(join(src, f), "utf8");
    for (const m of code.matchAll(/\b(?:t|k|tj)\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(JSON.parse(`"${m[1]}"`));
  }
  for (const r of Object.values(REASONS)) {
    keys.add(r.title);
    keys.add(r.plain);
  }
  for (const s of SCENARIOS) {
    keys.add(s.title);
    keys.add(s.summary);
    for (const x of [...s.basis.facts, ...s.basis.assumptions]) keys.add(x);
    for (const e of s.events) if (!EVENT_PATTERNS.some((re) => re.test(e.label))) keys.add(e.label);
  }
  return [...keys].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const keys = collectKeys();
  if (process.argv.includes("--keys")) console.log(JSON.stringify(keys, null, 1));
  else {
    const { STRINGS } = await import("./src/strings.ts");
    const langs = ["zh", "ja", "ko", "es", "fr", "pt", "de", "ru", "tr", "vi"] as const;
    for (const l of langs) {
      const missing = keys.filter((k) => !STRINGS[k]?.[l]);
      console.log(`${l}: ${missing.length} missing`);
    }
    const unused = Object.keys(STRINGS).filter((k) => !keys.includes(k));
    if (unused.length) console.log(`unused: ${unused.length}`, unused.slice(0, 10));
  }
}
