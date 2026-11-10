import { describe, expect, it } from "vitest";
import {
  attestationMessage, base58Decode, base58Encode, base64ToBytes, bytesToBase64, canonicalize, decodeJson, encodeJson,
  formatUnits, generateWatcherKey, hashCanonical, isValidRouteId, normalizeRoute, parseRoute, parseUnits, publicKeyFromSecret,
  ratioPpm, routeChains, signAttestation, toUsdCents, verifyAttestation, worstStatus, type VerdictPayload,
} from "@watchtower/core";

describe("canonical JSON", () => {
  it("sorts keys, encodes bigint as string, and is stable", () => {
    expect(canonicalize({ b: 1, a: [true, null, 2n], c: undefined })).toBe('{"a":[true,null,"2"],"b":1}');
    expect(hashCanonical({ x: 1, y: 2 })).toBe(hashCanonical({ y: 2, x: 1 }));
  });
  it("rejects floats and undefined array items (determinism hazards)", () => {
    expect(() => canonicalize({ a: 0.1 })).toThrow(/non-integer/);
    expect(() => canonicalize([undefined])).toThrow(/undefined array item/);
  });
  it("round-trips bigints through encodeJson/decodeJson, escaping look-alike strings", () => {
    const v = { amt: 12345678901234567890n, s: "42n", neg: -5n };
    expect(decodeJson(encodeJson(v))).toEqual(v);
  });
});

describe("routes", () => {
  it("normalises case and whitespace", () => {
    expect(normalizeRoute(" BTC:Bitcoin -> USDC:NEAR ")).toBe("btc:bitcoin->usdc:near");
    expect(parseRoute("eth:ethereum->sol:solana").dstChain).toBe("solana");
  });
  it("lists every chain a route depends on, always including NEAR", () => {
    expect(routeChains("btc:bitcoin->usdt:bsc")).toEqual(["bitcoin", "bsc", "near"]);
  });
  it("validates ids like the contract does", () => {
    expect(isValidRouteId("btc:bitcoin->usdc:near")).toBe(true);
    expect(isValidRouteId("BTC:bitcoin->usdc:near")).toBe(false);
    expect(isValidRouteId("btc:bitcoin->btc:bitcoin")).toBe(false);
    expect(isValidRouteId("a|b->c:d")).toBe(false);
  });
});

describe("money", () => {
  it("converts units to USD cents exactly", () => {
    // 1.5 BTC at $96,000 = $144,000 = 14,400,000 cents
    expect(toUsdCents(150_000_000n, 8, 96_000_000_000n)).toBe(14_400_000n);
  });
  it("parses and formats units", () => {
    expect(parseUnits("1.5", 6)).toBe(1_500_000n);
    expect(formatUnits(1_500_000n, 6)).toBe("1.5");
    expect(() => parseUnits("1.0000001", 6)).toThrow();
  });
  it("computes ratios in ppm and handles empty denominators", () => {
    expect(ratioPpm(995n, 1000n)).toBe(995_000);
    expect(ratioPpm(1n, 0n)).toBeNull();
  });
  it("orders statuses pessimistically", () => {
    expect(worstStatus("green", "amber")).toBe("amber");
    expect(worstStatus("amber", "unknown")).toBe("unknown");
    expect(worstStatus("unknown", "red", "green")).toBe("red");
  });
});

describe("attestations", () => {
  const payload: VerdictPayload = { route_id: "btc:bitcoin->usdc:near", epoch: 29_843_520, status: "red", score: 18, capacity_usd: 0, reasons: ["GHOST_CREDIT:btc:bitcoin", "OUTFLOW_SPIKE:btc:bitcoin"], report_hash: "ab".repeat(32) };

  it("base58 and base64 round-trip, including leading zeros", () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 255, 128, 7]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new TextEncoder().encode("near"))).toBe("bmVhcg==");
  });

  it("builds the exact line the contract rebuilds", () => {
    expect(attestationMessage("watchtower.near", payload)).toBe(
      "iwt:v2|watchtower.near|btc:bitcoin->usdc:near|29843520|red|18|0|GHOST_CREDIT:btc:bitcoin,OUTFLOW_SPIKE:btc:bitcoin|" + "ab".repeat(32),
    );
  });

  it("signs and verifies with NEAR-format keys", () => {
    const key = generateWatcherKey(new Uint8Array(32).fill(7));
    expect(key.publicKey.startsWith("ed25519:")).toBe(true);
    expect(publicKeyFromSecret(key.secretKey)).toBe(key.publicKey);
    const att = signAttestation("watchtower.near", payload, "w1.near", key.secretKey);
    expect(verifyAttestation("watchtower.near", payload, att, key.publicKey)).toBe(true);
  });

  it("a signature cannot be replayed on another contract, route, epoch or verdict", () => {
    const key = generateWatcherKey(new Uint8Array(32).fill(9));
    const att = signAttestation("watchtower.near", payload, "w1.near", key.secretKey);
    expect(verifyAttestation("watchtower.testnet", payload, att, key.publicKey)).toBe(false);
    expect(verifyAttestation("watchtower.near", { ...payload, status: "green" }, att, key.publicKey)).toBe(false);
    expect(verifyAttestation("watchtower.near", { ...payload, capacity_usd: 1 }, att, key.publicKey)).toBe(false);
    expect(verifyAttestation("watchtower.near", { ...payload, epoch: payload.epoch + 1 }, att, key.publicKey)).toBe(false);
    expect(verifyAttestation("watchtower.near", { ...payload, route_id: "eth:ethereum->usdc:near" }, att, key.publicKey)).toBe(false);
  });

  it("rejects malformed payloads before signing", () => {
    expect(() => attestationMessage("w.near", { ...payload, score: 101 })).toThrow();
    expect(() => attestationMessage("w.near", { ...payload, reasons: ["bad reason"] })).toThrow();
    expect(() => attestationMessage("w.near", { ...payload, report_hash: "xyz" })).toThrow();
    expect(() => attestationMessage("w.near", { ...payload, capacity_usd: 5_000 })).toThrow(/capacity_usd 0/);
    expect(() => attestationMessage("w.near", { ...payload, status: "green", capacity_usd: -1 })).toThrow();
  });
});
