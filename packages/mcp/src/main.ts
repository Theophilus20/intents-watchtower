#!/usr/bin/env node
import { liveSource, replaySource, type Source } from "./source.ts";
import { serveStdio, SERVER_INFO } from "./server.ts";

/**
 *   watchtower-mcp                                  replay of the October incident, 30 min in (default)
 *   watchtower-mcp --replay whale-day --at 45       another scenario / moment
 *   watchtower-mcp --live mainnet                   the deployed contract
 *   watchtower-mcp --live testnet --contract watchtower.testnet --rpc https://...
 *
 * The same settings work as environment variables: WATCHTOWER_LIVE, WATCHTOWER_REPLAY,
 * WATCHTOWER_AT, WATCHTOWER_CONTRACT, WATCHTOWER_RPC.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return process.env[`WATCHTOWER_${name.toUpperCase()}`];
}

function build(): Source {
  const live = arg("live");
  if (live) {
    if (live !== "mainnet" && live !== "testnet") throw new Error(`--live must be mainnet or testnet, got "${live}"`);
    return liveSource({ network: live, contractId: arg("contract"), rpcUrl: arg("rpc") });
  }
  const at = arg("at");
  return replaySource({ scenario: arg("replay"), at: at === undefined ? undefined : Number(at) });
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stderr.write("watchtower-mcp [--replay <scenario>] [--at <minutes>] | [--live mainnet|testnet] [--contract <id>] [--rpc <url>]\n");
  process.exit(0);
}

try {
  const src = build();
  process.stderr.write(`${SERVER_INFO.title} MCP server ready. ${src.label}\n`);
  await serveStdio(src);
} catch (e) {
  process.stderr.write(`watchtower-mcp: ${(e as Error).message}\n`);
  process.exit(1);
}
