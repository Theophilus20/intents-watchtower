import { describe, expect, it } from "vitest";
import { generateWatcherKey, type Attestation, type SubmitOutcome, type VerdictPayload } from "@watchtower/core";
import { World } from "@watchtower/replay";
import { WatcherNode, type Submitter } from "@watchtower/watcher";

const OK: SubmitOutcome = { applied: true, votes: 1, needed: 1, status: null };

/** Records what a watcher would send to the contract. */
class Recorder implements Submitter {
  single: string[] = [];
  batches: string[][] = [];
  failBatch = false;
  failSingle = false;
  batchError?: string;
  async submit(p: VerdictPayload, _a: Attestation[]) {
    if (this.failSingle) throw new Error("rpc down");
    this.single.push(p.route_id);
    return OK;
  }
  async submitMany(items: { payload: VerdictPayload; attestations: Attestation[] }[]) {
    if (this.batchError) throw new Error(this.batchError);
    if (this.failBatch) throw new Error("Smart contract panicked: invalid signature");
    this.batches.push(items.map((i) => i.payload.route_id));
    return items.map(() => OK);
  }
}

function node(sub: Submitter, refreshEpochs = 1) {
  const k = generateWatcherKey(new Uint8Array(32).fill(7));
  return new WatcherNode({ watcherId: "w1.watchtower.near", secretKey: k.secretKey, contractId: "watchtower.near", submitter: sub, refreshEpochs });
}

describe("watcher submission", () => {
  it("sends a whole round in one transaction", async () => {
    const sub = new Recorder();
    const w = node(sub);
    const world = new World({ seed: "batch", startMs: Date.UTC(2026, 10, 4) });
    const r = await w.step(world.tick());
    expect(sub.batches).toHaveLength(1);
    expect(sub.batches[0]).toHaveLength(r.report.routes.length);
    expect(sub.single).toHaveLength(0);
  });

  it("never re-sends an unchanged unverified verdict", async () => {
    const sub = new Recorder();
    const w = node(sub, 1);
    const world = new World({ seed: "nocustody", startMs: Date.UTC(2026, 10, 4) });
    const strip = (b: ReturnType<World["tick"]>) => ({ ...b, custody: [] });
    const first = await w.step(strip(world.tick()));
    const unknown = first.report.routes.filter((v) => v.status === "unknown").map((v) => v.route);
    expect(unknown.length).toBeGreaterThan(0);
    const second = await w.step(strip(world.tick()));
    const resent = second.attestations.map((a) => a.payload.route_id);
    for (const r of unknown) if (second.report.routes.find((v) => v.route === r)?.status === "unknown") expect(resent).not.toContain(r);
  });

  it("does not retry route by route when the RPC itself refuses", async () => {
    const sub = new Recorder();
    sub.batchError = "429 Too Many Requests";
    const w = node(sub);
    const world = new World({ seed: "ratelimit", startMs: Date.UTC(2026, 10, 4) });
    const r = await w.step(world.tick());
    expect(sub.single).toHaveLength(0);
    expect(r.attestations.every((a) => a.error?.includes("429"))).toBe(true);
  });

  it("falls back to one transaction per route when the contract rejects a batch", async () => {
    const sub = new Recorder();
    sub.failBatch = true;
    const w = node(sub);
    const world = new World({ seed: "fallback", startMs: Date.UTC(2026, 10, 4) });
    const r = await w.step(world.tick());
    expect(sub.single).toHaveLength(r.report.routes.length);
    expect(r.attestations.every((a) => a.outcome && !a.error)).toBe(true);
  });

  it("retries a change that failed to send, without announcing it twice", async () => {
    const sub = new Recorder();
    sub.failBatch = true;
    sub.failSingle = true;
    const w = node(sub, 1_000);
    const world = new World({ seed: "retry", startMs: Date.UTC(2026, 10, 4) });
    const first = await w.step(world.tick());
    expect(first.attestations.every((a) => a.error)).toBe(true);
    sub.failBatch = false;
    sub.failSingle = false;
    const second = await w.step(world.tick());
    expect(sub.batches[0]).toHaveLength(first.attestations.length);
    expect(second.transitions).toHaveLength(0);
  });
});
