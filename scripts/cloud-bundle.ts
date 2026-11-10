/**
 * Packs what the watchers need to run in the cloud into one secret value:
 * watchtower.config.json, data/watcher-1..3.json and data/relayer.json (plus FASTNEAR_API_KEY if set).
 *   npm run cloud:bundle
 * The value is written to data/cloud-bundle.txt (never committed). Paste it into your host's secret
 * variable WATCHTOWER_BUNDLE. Treat it like the keys themselves: anyone holding it can sign as your watchers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const files: Record<string, string> = {};
for (const f of ["watchtower.config.json", "data/watcher-1.json", "data/watcher-2.json", "data/watcher-3.json", "data/relayer.json"]) {
  if (existsSync(f)) files[f] = readFileSync(f, "utf8");
}
const missing = ["watchtower.config.json", "data/watcher-1.json", "data/watcher-2.json", "data/watcher-3.json"].filter((f) => !files[f]);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")}. Run this in the folder your watchers run from.`);
  process.exit(1);
}
const env: Record<string, string> = {};
for (const k of ["FASTNEAR_API_KEY", "WATCHTOWER_DATA_MB", "WATCHTOWER_REFRESH_MINUTES"]) if (process.env[k]) env[k] = process.env[k]!;
const bundle = gzipSync(JSON.stringify({ v: 1, files, env })).toString("base64");
mkdirSync("data", { recursive: true });
writeFileSync("data/cloud-bundle.txt", bundle);
console.log(`Wrote data/cloud-bundle.txt (${bundle.length.toLocaleString("en-US")} characters): ${Object.keys(files).length} files${Object.keys(env).length ? `, ${Object.keys(env).join(", ")}` : ""}.`);
console.log("Paste its contents into the secret variable WATCHTOWER_BUNDLE on your host. Never share or commit it.");
