/**
 * Runs all three watchers as one cloud service (Railway, Fly, any container host).
 * Reads the secret variable WATCHTOWER_BUNDLE (made by npm run cloud:bundle), writes the config and
 * key files it holds, then starts watcher 1, 2 and 3 and restarts any that stops.
 * In production each watcher belongs on a different machine run by a different person; one service
 * is the demo arrangement.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync } from "node:zlib";

const raw = process.env.WATCHTOWER_BUNDLE?.trim();
if (!raw) {
  console.error("WATCHTOWER_BUNDLE is not set. Run npm run cloud:bundle on the machine that holds the keys and paste the value into this service's variables.");
  process.exit(1);
}
let bundle: { files: Record<string, string>; env?: Record<string, string> };
try {
  bundle = JSON.parse(gunzipSync(Buffer.from(raw, "base64")).toString("utf8"));
} catch {
  console.error("WATCHTOWER_BUNDLE could not be read. Paste the whole contents of data/cloud-bundle.txt, with nothing added.");
  process.exit(1);
}
const ALLOWED = /^(watchtower\.config\.json|data\/(watcher-[1-3]|relayer)\.json)$/;
for (const [path, body] of Object.entries(bundle.files)) {
  if (!ALLOWED.test(path)) continue;
  mkdirSync(dirname(path) || ".", { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
}
console.log(`cloud: ${Object.keys(bundle.files).length} files restored, starting 3 watchers`);

const stats = [1, 2, 3].map((n) => ({ n, starts: 0, lastLineAt: 0 }));
let stopping = false;
function start(s: (typeof stats)[number]): void {
  s.starts++;
  const child = spawn("tsx", ["packages/watcher/src/cli.ts", "run", "--config", "watchtower.config.json", "--submit", "--watcher", String(s.n)], { env: { ...process.env, ...(bundle.env ?? {}), WATCHTOWER_BUNDLE: "" }, stdio: ["ignore", "pipe", "pipe"] });
  const relay = (chunk: Buffer) => {
    s.lastLineAt = Date.now();
    for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) console.log(`[w${s.n}] ${line}`);
  };
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);
  child.on("exit", (code) => {
    if (stopping) return;
    console.log(`[w${s.n}] stopped (code ${code}); starting again in 15 s`);
    setTimeout(() => start(s), 15_000);
  });
  process.once("SIGTERM", () => child.kill("SIGTERM"));
}
// Stagger the starts so the three don't hit the public endpoints in the same second.
stats.forEach((s, i) => setTimeout(() => start(s), i * 20_000));
process.once("SIGTERM", () => { stopping = true; setTimeout(() => process.exit(0), 3_000); });

// A tiny health page, for hosts that expect a web port. It shows no secrets.
const port = Number(process.env.PORT ?? 0);
if (port) {
  createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, watchers: stats.map((s) => ({ watcher: s.n, starts: s.starts, lastOutputSecondsAgo: s.lastLineAt ? Math.round((Date.now() - s.lastLineAt) / 1000) : null })) }));
  }).listen(port, () => console.log(`cloud: health page on port ${port}`));
}
