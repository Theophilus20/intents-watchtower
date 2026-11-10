/**
 * Writes config/public.config.json: the public part of watchtower.config.json (contract id, bridge
 * wallets, token contracts). It lets a hosted status page check backing itself. Nothing secret is
 * copied: keys, key paths, API keys and everything not listed below stay out.
 *   npm run config:public
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const src = process.argv[2] ?? "watchtower.config.json";
const out = process.argv[3] ?? "config/public.config.json";
if (!existsSync(src)) {
  console.error(`${src} not found. Run this where your watcher config lives.`);
  process.exit(1);
}
const file = JSON.parse(readFileSync(src, "utf8")) as { contractId?: string; live?: { chains?: Record<string, { kind?: string; url?: string }>; assets?: Record<string, Record<string, unknown>> } };
const ASSET_FIELDS = ["custody", "hotWallets", "token", "nearContract", "mtTokenId", "issuerAccounts", "partial"];
const assets: Record<string, Record<string, unknown>> = {};
for (const [key, a] of Object.entries(file.live?.assets ?? {})) {
  const kept: Record<string, unknown> = {};
  for (const f of ASSET_FIELDS) if (a[f] !== undefined) kept[f] = a[f];
  assets[key] = kept;
}
// Chain endpoints are kept only when they carry no key (no query string, no credentials).
const chains: Record<string, { kind: string; url: string }> = {};
for (const [name, c] of Object.entries(file.live?.chains ?? {})) {
  if (!c.kind || !c.url) continue;
  const u = new URL(c.url);
  if (u.search || u.username || u.password || /key|token|secret/i.test(u.pathname)) continue;
  chains[name] = { kind: c.kind, url: c.url };
}
mkdirSync("config", { recursive: true });
writeFileSync(out, JSON.stringify({ _comment: "Public wallet list for the hosted status page. Made by npm run config:public. Contains no keys.", contractId: file.contractId, live: { chains, assets } }, null, 2) + "\n");
console.log(`Wrote ${out}: ${Object.keys(assets).length} assets, ${Object.keys(chains).length} chain endpoints, no keys.`);
