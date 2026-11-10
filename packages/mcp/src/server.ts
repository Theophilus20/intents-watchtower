import { TOOLS, callTool } from "./tools.ts";
import type { Source } from "./source.ts";

/**
 * A Model Context Protocol server over stdio, without dependencies.
 *
 * MCP's stdio transport is newline-delimited JSON-RPC 2.0. This handles the lifecycle
 * (initialize / initialized / ping) and the tools capability (tools/list, tools/call), which is
 * all a read-only oracle needs. Nothing but protocol messages is ever written to stdout.
 */

export const SERVER_INFO = { name: "intents-watchtower", title: "Intents Watchtower", version: "1.0.0" };
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = [
  "Intents Watchtower is an independent safety check for NEAR Intents routes.",
  "Before any swap, bridge or withdrawal through NEAR Intents, call check_swap with the tokens and the dollar amount, and only send when the decision is \"go\".",
  "Follow \"reroute\" and \"reduce\" advice exactly; on \"wait\", do not send and tell the user why.",
  "Every answer starts with its source line. If it says replay, the data is simulated: say so to the user.",
].join(" ");

type Id = string | number;
interface Request { jsonrpc: "2.0"; id?: Id; method: string; params?: Record<string, unknown> }
type Response = { jsonrpc: "2.0"; id: Id | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

export async function handle(msg: unknown, src: Source): Promise<Response | null> {
  if (!msg || typeof msg !== "object" || (msg as Request).jsonrpc !== "2.0" || typeof (msg as Request).method !== "string") {
    return { jsonrpc: "2.0", id: ((msg as Request | null)?.id ?? null) as Id | null, error: { code: -32600, message: "Invalid request" } };
  }
  const req = msg as Request;
  const isNotification = req.id === undefined;
  const ok = (result: unknown): Response | null => (isNotification ? null : { jsonrpc: "2.0", id: req.id!, result });
  const err = (code: number, message: string): Response | null => (isNotification ? null : { jsonrpc: "2.0", id: req.id!, error: { code, message } });

  switch (req.method) {
    case "initialize": {
      const asked = String(req.params?.protocolVersion ?? "");
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: `${INSTRUCTIONS} Source: ${src.label}`,
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return err(-32602, `Unknown tool: ${name}`);
      return ok(await callTool(name, (req.params?.arguments ?? {}) as Record<string, unknown>, src));
    }
    default:
      return err(-32601, `Method not found: ${req.method}`);
  }
}

/** Serve on stdin/stdout until stdin closes. */
export function serveStdio(src: Source, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  return new Promise((resolve) => {
    let buf = "";
    let queue = Promise.resolve();
    const write = (r: Response | null) => {
      if (r) output.write(`${JSON.stringify(r)}\n`);
    };
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        // Answer in order: one request at a time keeps responses deterministic for clients and tests.
        queue = queue.then(async () => {
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            return;
          }
          try {
            write(await handle(msg, src));
          } catch (e) {
            const id = (msg as Request).id;
            if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32603, message: (e as Error).message } });
          }
        });
      }
    });
    input.on("end", () => void queue.then(() => resolve()));
  });
}
