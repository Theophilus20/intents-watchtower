import { describe, expect, it } from "vitest";
import { ContractMirror, generateWatcherKey, signAttestation, type VerdictPayload } from "@watchtower/core";
import { getScenario, World } from "@watchtower/replay";
import { LocalNetwork } from "@watchtower/watcher";
import vectors from "../../../test-vectors/attestation.json" with { type: "json" };

describe("watcher network over the October replay", () => {
  it("three independent watchers agree on every hash and the contract follows the engine", async () => {
    const s = getScenario("oct-2026-ghost-credit");
    const net = new LocalNetwork({ watchers: 3, quorum: 2 });
    const world = new World({ seed: s.seed, startMs: s.startMs - s.incidentAtMin * 60_000 });
    let redAt: number | null = null;
    for (let m = 0; m <= s.incidentAtMin + 8; m++) {
      const due = s.events.filter((e) => e.atMin === m);
      const results = await net.step(world.tick(60_000, (w) => due.forEach((e) => e.apply(w))));
      const hashes = results.map((r) => r.report.routes.map((v) => v.reportHash).join());
      expect(new Set(hashes).size).toBe(1);
      if (redAt === null && !net.mirror.isSafe("usdt:bsc->usdc:near", 300, true) && net.mirror.checkRoute("usdt:bsc->usdc:near").status === "red") redAt = m - s.incidentAtMin;
      if (m === s.incidentAtMin - 1) {
        expect(net.mirror.isSafe("usdt:bsc->usdc:near")).toBe(true);
        expect(net.mirror.checkRoute("btc:bitcoin->usdc:near").reasons).toEqual([]);
      }
    }
    expect(redAt).toBe(4);
    expect(net.mirror.isSafe("btc:bitcoin->usdc:near")).toBe(true);
    expect(net.mirror.routes.get("usdt:bsc->usdc:near")!.signers).toBeGreaterThanOrEqual(2);
  });

  it("a watcher fed tampered data is visible, and can only make the contract more careful", async () => {
    // Watcher 3's RPC hides half the custody balance: it sees a backing hole the others don't.
    const net = new LocalNetwork({
      watchers: 3,
      quorum: 2,
      tamper: (i, b) => {
        if (i === 2) for (const c of b.custody ?? []) c.balance = c.balance / 2n;
        return b;
      },
    });
    const world = new World({ seed: "tamper", startMs: Date.UTC(2026, 10, 4) });
    for (let m = 0; m < 3; m++) await net.step(world.tick());
    // Its alarm stands (one watcher may raise one), and the disagreement is on the record.
    expect(net.mirror.isSafe("btc:bitcoin->usdc:near")).toBe(false);
    expect(net.mirror.checkRoute("btc:bitcoin->usdc:near").status).toBe("red");
    expect(net.mirror.events.some((e) => e.event === "watcher_disagreement")).toBe(true);
  });

  it("honest watchers whose data differs slightly still agree on green", async () => {
    // Each watcher reads custody a moment apart: balances differ by a few sats, hashes differ.
    const net = new LocalNetwork({
      watchers: 3,
      quorum: 2,
      tamper: (i, b) => {
        for (const c of b.custody ?? []) c.balance = c.balance + BigInt(i * 1_000);
        return b;
      },
    });
    const world = new World({ seed: "jitter", startMs: Date.UTC(2026, 10, 4) });
    for (let m = 0; m < 3; m++) await net.step(world.tick());
    expect(net.mirror.isSafe("btc:bitcoin->usdc:near")).toBe(true);
  });
});

describe("TypeScript contract mirror matches the Rust contract", () => {
  it("accepts the same cross-language vectors", () => {
    const m = new ContractMirror(vectors.contract_id, 2, 1);
    for (const w of vectors.watchers) m.addWatcher(w.account_id, w.public_key);
    for (const c of vectors.cases) {
      m.nowMs = c.report.epoch * 60_000 + 30_000;
      const out = m.submitReport(c.report as VerdictPayload, c.attestations);
      expect(out.applied).toBe(true);
    }
  });

  it("enforces fast-red / slow-green exactly like the contract", () => {
    const m = new ContractMirror("watchtower.near", 2, 1);
    const E = 29_843_520;
    m.nowMs = E * 60_000 + 30_000;
    const ks = [1, 2, 3].map((i) => ({ id: `w${i}.near`, key: generateWatcherKey(new Uint8Array(32).fill(i)) }));
    ks.forEach((k) => m.addWatcher(k.id, k.key.publicKey));
    const p = (epoch: number, status: VerdictPayload["status"], h: string): VerdictPayload => ({ route_id: "btc:bitcoin->usdc:near", epoch, status, score: status === "green" ? 100 : 10, capacity_usd: status === "green" ? 80_000 : 0, reasons: [], report_hash: h.repeat(64) });
    const sign = (pl: VerdictPayload, i: number) => signAttestation("watchtower.near", pl, ks[i]!.id, ks[i]!.key.secretKey);
    expect(m.submitReport(p(E, "green", "a"), [sign(p(E, "green", "a"), 0)]).applied).toBe(false);
    expect(m.submitReport(p(E, "green", "a"), [sign(p(E, "green", "a"), 1)]).applied).toBe(true);
    expect(m.submitReport(p(E, "red", "b"), [sign(p(E, "red", "b"), 2)]).applied).toBe(true);
    expect(m.submitReport(p(E, "green", "c"), [sign(p(E, "green", "c"), 0)]).applied).toBe(false);
    expect(m.submitReport(p(E, "unknown", "d"), [sign(p(E, "unknown", "d"), 0)]).applied).toBe(false);
    // An older report from a watcher that already spoke changes nothing.
    expect(m.submitReport(p(E - 1, "green", "e"), [sign(p(E - 1, "green", "e"), 0)]).applied).toBe(false);
    expect(m.checkRoute("btc:bitcoin->usdc:near").status).toBe("red");
  });
});
