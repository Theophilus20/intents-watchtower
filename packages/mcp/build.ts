import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One self-contained file, so MCP clients can run it with plain `node`, no tsx or npx needed. */
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "watchtower-mcp.mjs");
mkdirSync(dirname(out), { recursive: true });
await build({
  entryPoints: [join(here, "src", "main.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
});
console.log(`built ${out}`);
