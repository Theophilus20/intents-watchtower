import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileBlockCache } from "@watchtower/watcher";

describe("shared block cache", () => {
  it("lets a second watcher reuse what the first downloaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blocks-"));
    const a = new FileBlockCache(dir);
    const b = new FileBlockCache(dir);
    let downloads = 0;
    const load = async () => { downloads++; return { height: 9 }; };
    expect(await a.get("9-h", load)).toEqual({ height: 9 });
    expect(await b.get("9-h", load)).toEqual({ height: 9 });
    expect(downloads).toBe(1);
  });

  it("downloads once when two watchers ask at the same moment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blocks-"));
    const a = new FileBlockCache(dir);
    const b = new FileBlockCache(dir);
    let downloads = 0;
    const load = async () => { downloads++; await new Promise((r) => setTimeout(r, 300)); return [1, 2, 3]; };
    const [x, y] = await Promise.all([a.get("10-s7", load), b.get("10-s7", load)]);
    expect(x).toEqual([1, 2, 3]);
    expect(y).toEqual([1, 2, 3]);
    expect(downloads).toBe(1);
  });

  it("does not cache a missing block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blocks-"));
    const c = new FileBlockCache(dir);
    let downloads = 0;
    const load = async () => { downloads++; return null; };
    await c.get("11-h", load);
    await c.get("11-h", load);
    expect(downloads).toBe(2);
  });
});
