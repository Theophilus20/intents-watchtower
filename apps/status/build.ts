/**
 * Builds the status app into one self-contained HTML file.
 *   dist/index.html       body fragment (for hosts that wrap it, e.g. claude.ai artifacts)
 *   dist/standalone.html  full document for any static host (Vercel, Netlify, GitHub Pages, IPFS)
 *   dist/site/index.html  the same document, ready to deploy as a site root
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// Embed token icons from public/tokens as data URIs (works offline and inside embedded previews).
const MIME: Record<string, string> = { svg: "image/svg+xml", png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg" };
const tokenIcons: Record<string, string> = {};
const tokenDir = join(here, "public/tokens");
if (existsSync(tokenDir)) {
  for (const f of readdirSync(tokenDir)) {
    const m = /^([a-z0-9]+)\.(svg|png|webp|jpe?g)$/i.exec(f);
    if (!m) continue;
    tokenIcons[m[1]!.toLowerCase()] = `data:${MIME[m[2]!.toLowerCase()]};base64,${readFileSync(join(tokenDir, f)).toString("base64")}`;
  }
}

// WATCHTOWER_LIVE=testnet:watchtower.you.testnet makes the page open on that live contract instead of a replay.
const liveEnv = process.env.WATCHTOWER_LIVE?.trim();
let defaultLive: { network: string; contractId: string } | null = null;
if (liveEnv) {
  const [network, contractId] = liveEnv.split(":");
  if ((network !== "testnet" && network !== "mainnet") || !contractId) throw new Error(`WATCHTOWER_LIVE must look like testnet:watchtower.you.testnet, got "${liveEnv}"`);
  defaultLive = { network, contractId };
}

// The page checks backing itself in live mode, from the wallets in the watcher config (all public).
let proof: unknown = null;
if (defaultLive) {
  const cfgPath = process.env.WATCHTOWER_CONFIG ?? join(process.cwd(), "watchtower.config.json");
  if (existsSync(cfgPath)) {
    const { DEFAULT_ASSETS } = await import("@watchtower/core");
    const file = JSON.parse(readFileSync(cfgPath, "utf8")) as { live?: { near?: { rpcUrl?: string }; chains?: Record<string, { kind: string; url: string }>; assets?: Record<string, { custody?: string[]; token?: string; nearContract?: string; mtTokenId?: string; issuerAccounts?: string[]; partial?: unknown }> } };
    const chains = {
      bitcoin: { kind: "esplora", url: "https://mempool.space/api" },
      ethereum: { kind: "evm", url: "https://ethereum-rpc.publicnode.com" },
      bsc: { kind: "evm", url: "https://bsc-rpc.publicnode.com" },
      solana: { kind: "solana", url: "https://api.mainnet-beta.solana.com" },
      litecoin: { kind: "esplora", url: "https://litecoinspace.org/api" },
      ...(file.live?.chains ?? {}),
    };
    const assets: Record<string, unknown> = {};
    for (const [key, a] of Object.entries(file.live?.assets ?? {})) {
      const reg = DEFAULT_ASSETS.find((x) => x.key === key);
      const custody = (a.custody ?? []).filter((x) => x && !x.startsWith("<"));
      if (!reg || !a.nearContract || !custody.length) continue;
      assets[key] = { chain: reg.chain, decimals: reg.decimals, custody, token: a.token, nearContract: a.nearContract, mtTokenId: a.mtTokenId, issuerAccounts: a.issuerAccounts, partial: !!a.partial };
    }
    // The data is mainnet's whatever network the contract is on.
    proof = { nearRpc: "https://free.rpc.fastnear.com", chains, assets };
    console.log(`Backing check: ${Object.keys(assets).length} assets from ${cfgPath}`);
  }
}

const out = await build({
  entryPoints: [join(here, "src/main.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020", "safari15"],
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: true,
  legalComments: "none",
  write: false,
  define: { "process.env.NODE_ENV": '"production"', __TOKEN_ICONS__: JSON.stringify(tokenIcons), __DEFAULT_LIVE__: JSON.stringify(defaultLive), __WT_PROOF__: JSON.stringify(proof) },
});
const js = out.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync(join(here, "src/styles.css"), "utf8");
const template = readFileSync(join(here, "src/template.html"), "utf8");
const fragment = template.replace("/*__CSS__*/", () => css).replace("/*__APP__*/", () => js);
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist/index.html"), fragment);
const cut = fragment.indexOf('<div id="app">');
const appIcon = existsSync(join(here, "public/brand/app-icon.svg")) ? readFileSync(join(here, "public/brand/app-icon.svg")).toString("base64") : "";
const iconLink = appIcon ? `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${appIcon}">\n` : "";
writeFileSync(
  join(here, "dist/standalone.html"),
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#f4f6f8" media="(prefers-color-scheme: light)">\n<meta name="theme-color" content="#0b0f14" media="(prefers-color-scheme: dark)">\n${iconLink}<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n${fragment.slice(0, cut)}\n</head>\n<body>\n${fragment.slice(cut)}\n</body>\n</html>\n`,
);
// Ready-to-host folder: drop dist/site on Vercel, Netlify, GitHub Pages or IPFS.
mkdirSync(join(here, "dist/site"), { recursive: true });
writeFileSync(join(here, "dist/site/index.html"), readFileSync(join(here, "dist/standalone.html")));
// Your own assets (logo, token icons) ship alongside the page.
if (existsSync(join(here, "public"))) cpSync(join(here, "public"), join(here, "dist/site"), { recursive: true });
console.log(`token icons embedded: ${Object.keys(tokenIcons).join(", ") || "none"}`);
if (defaultLive) console.log(`opens live on ${defaultLive.contractId} (${defaultLive.network})`);
console.log(`status app: ${(fragment.length / 1024).toFixed(0)} KB (script ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);
