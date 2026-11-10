import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AssetError, assetCatalog, handle, replaySource, resolveAsset, TOOLS, type Source } from "@watchtower/mcp";

const during = replaySource({ scenario: "oct-2026-ghost-credit", at: 30 });
const before = replaySource({ scenario: "oct-2026-ghost-credit", at: -10 });

async function call(src: Source, name: string, args: Record<string, unknown>) {
  const r = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, src))!;
  return r.result as { content: { text: string }[]; structuredContent: Record<string, any>; isError?: boolean };
}

describe("asset names", () => {
  const catalog = assetCatalog();
  it("accepts keys, words and aliases", () => {
    expect(resolveAsset("usdt:bsc", catalog)).toBe("usdt:bsc");
    expect(resolveAsset("USDT on BSC", catalog)).toBe("usdt:bsc");
    expect(resolveAsset("usdt (BNB Chain)", catalog)).toBe("usdt:bsc");
    expect(resolveAsset("btc", catalog)).toBe("btc:bitcoin");
    expect(resolveAsset("NEAR", catalog)).toBe("near:near");
  });
  it("asks which chain when a symbol lives on several", () => {
    expect(() => resolveAsset("usdc", catalog)).toThrow(AssetError);
    expect(() => resolveAsset("usdc", catalog)).toThrow(/Ethereum.*NEAR|NEAR.*Ethereum/);
  });
});

describe("protocol", () => {
  it("negotiates the protocol version and advertises tools", async () => {
    const init = (await handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, during))!;
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "intents-watchtower" } });
    expect((init.result as any).instructions).toMatch(/check_swap/);
    const future = (await handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2099-01-01" } }, during))!;
    expect((future.result as any).protocolVersion).toBe("2025-06-18");

    const list = (await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, during))!;
    expect((list.result as any).tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const t of (list.result as any).tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });

  it("stays silent on notifications and errors on unknown methods or tools", async () => {
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, during)).toBeNull();
    expect((await handle({ jsonrpc: "2.0", id: 2, method: "nope" }, during))!.error!.code).toBe(-32601);
    expect((await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }, during))!.error!.code).toBe(-32602);
    expect((await handle({ jsonrpc: "2.0", id: 4, method: "ping" }, during))!.result).toEqual({});
  });
});

describe("check_swap", () => {
  it("says go on a healthy route within its safe size", async () => {
    const r = await call(during, "check_swap", { from: "btc:bitcoin", to: "usdc:near", amount_usd: 20_000 });
    expect(r.structuredContent.decision).toBe("go");
    expect(r.structuredContent.contract_check.allowed).toBe(true);
    expect(r.content[0]!.text).toMatch(/^Replay of .*simulated/);
    expect(r.content[0]!.text).toMatch(/GO\. \$20,000/);
  });

  it("reroutes away from the ghost-credit route during the incident", async () => {
    const r = await call(during, "check_swap", { from: "USDT on BSC", to: "USDC on NEAR", amount_usd: 50_000 });
    expect(r.structuredContent.status).toBe("red");
    expect(r.structuredContent.safe_size_usd).toBe(0);
    expect(r.structuredContent.contract_check.allowed).toBe(false);
    expect(["reroute", "wait"]).toContain(r.structuredContent.decision);
    if (r.structuredContent.decision === "reroute") {
      expect(r.structuredContent.alternative.route).not.toMatch(/usdt:bsc/);
      expect(r.content[0]!.text).toMatch(/credited.*no matching deposit/i);
    }
  });

  it("allowed the same swap ten minutes before the incident", async () => {
    const r = await call(before, "check_swap", { from: "usdt:bsc", to: "usdc:near", amount_usd: 50_000 });
    expect(r.structuredContent.decision).toBe("go");
  });

  it("asks to split, or reroutes, a swap larger than the safe size", async () => {
    const r = await call(during, "check_swap", { from: "btc:bitcoin", to: "usdc:near", amount_usd: 5_000_000 });
    expect(["reduce", "wait", "reroute"]).toContain(r.structuredContent.decision);
    expect(r.structuredContent.contract_check.verdict).toBe("over_capacity");
    if (r.structuredContent.decision === "reduce") expect(r.structuredContent.split_into).toBeGreaterThan(1);
  });

  it("returns a tool error, not a crash, for a token it cannot read", async () => {
    const r = await call(during, "check_swap", { from: "usdc", to: "btc", amount_usd: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/several chains/);
  });
});

describe("other tools", () => {
  it("check_route mirrors is_safe and explains why", async () => {
    const r = await call(during, "check_route", { from: "usdt:bsc", to: "usdc:near" });
    expect(r.structuredContent.safe).toBe(false);
    expect(r.content[0]!.text).toMatch(/NOT SAFE/);
    const ok = await call(during, "check_route", { from: "eth:ethereum", to: "usdc:near" });
    expect(ok.structuredContent.safe).toBe(true);
    expect(ok.structuredContent.safe_size_usd).toBeGreaterThan(0);
  });

  it("list_routes puts problems first", async () => {
    const r = await call(during, "list_routes", {});
    const rows = r.structuredContent.routes as { status: string }[];
    expect(rows.length).toBe(12);
    expect(rows[0]!.status).toBe("red");
    expect(rows.at(-1)!.status).toBe("green");
    const red = await call(during, "list_routes", { status: "red" });
    expect((red.structuredContent.routes as unknown[]).length).toBeGreaterThan(0);
  });

  it("explain_route speaks French and Spanish", async () => {
    const fr = await call(during, "explain_route", { from: "usdt:bsc", to: "usdc:near", lang: "fr" });
    expect(fr.content[0]!.text).toMatch(/Évitez cette route/);
    const es = await call(during, "explain_route", { from: "usdt:bsc", to: "usdc:near", lang: "es" });
    expect(es.content[0]!.text).toMatch(/Evita esta ruta/);
  });
});

describe("stdio transport", () => {
  it("answers a real client session over stdin/stdout", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const child = spawn(process.execPath, ["--import", "tsx", join(root, "packages", "mcp", "src", "main.ts"), "--replay", "oct-2026-ghost-credit", "--at", "30"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    const lines: any[] = [];
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_swap", arguments: { from: "usdt:bsc", to: "usdc:near", amount_usd: 50_000 } } });
    child.stdin.end();
    const code = await new Promise<number | null>((res) => child.on("close", res));
    expect(code).toBe(0);
    expect(lines.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(lines[1].result.tools).toHaveLength(4);
    expect(lines[2].result.structuredContent.contract_check.allowed).toBe(false);
  }, 60_000);
});
