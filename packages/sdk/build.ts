/** Builds dist/ (ESM, minified) for npm publishing. */
import { build } from "esbuild";
const common = { bundle: true, format: "esm" as const, platform: "neutral" as const, target: "es2020", minify: true, sourcemap: true };
await build({ ...common, entryPoints: ["packages/sdk/src/index.ts"], outfile: "packages/sdk/dist/index.js" });
await build({ ...common, entryPoints: ["packages/sdk/src/badge.ts"], outfile: "packages/sdk/dist/badge.js", platform: "browser" });
console.log("sdk built: packages/sdk/dist/");
