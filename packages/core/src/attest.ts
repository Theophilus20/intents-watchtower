import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Status } from "./types.ts";

ed.hashes.sha512 = sha512;

/**
 * Watcher attestations.
 *
 * A watcher signs one line of text that pins everything the contract will store. The exact
 * same string is rebuilt inside watchtower.near (see contracts/watchtower/src/attestation.rs),
 * so a signature can be relayed by anyone but can only ever mean one verdict, for one route,
 * in one epoch, on one contract.
 *
 *   iwt:v2|<contract_id>|<route_id>|<epoch>|<status>|<score>|<capacity_usd>|<reasons,comma,joined>|<report_hash>
 *
 * v2 adds the safe size, so an agent can enforce "how much", not only "whether".
 */
export const ATTESTATION_DOMAIN = "iwt:v2";

export interface VerdictPayload {
  route_id: string;
  epoch: number;
  status: Status;
  score: number;
  /** Safe size in whole USD; 0 = blocked. */
  capacity_usd: number;
  reasons: string[];
  report_hash: string;
}

export interface Attestation {
  watcher_id: string;
  /** base64 ed25519 signature over attestationMessage(contract, payload) */
  signature: string;
}

export function attestationMessage(contractId: string, p: VerdictPayload): string {
  validatePayload(p);
  return [ATTESTATION_DOMAIN, contractId, p.route_id, String(p.epoch), p.status, String(p.score), String(p.capacity_usd), p.reasons.join(","), p.report_hash].join("|");
}

export function validatePayload(p: VerdictPayload): void {
  if (!Number.isSafeInteger(p.epoch) || p.epoch < 0) throw new Error("epoch must be a non-negative integer");
  if (!Number.isInteger(p.score) || p.score < 0 || p.score > 100) throw new Error("score must be 0..100");
  if (!Number.isSafeInteger(p.capacity_usd) || p.capacity_usd < 0) throw new Error("capacity_usd must be a non-negative integer");
  if ((p.status === "red" || p.status === "unknown") && p.capacity_usd !== 0) throw new Error("unsafe or unverified verdicts must have capacity_usd 0");
  if (!/^[0-9a-f]{64}$/.test(p.report_hash)) throw new Error("report_hash must be 64 lowercase hex chars");
  if (p.reasons.length > 16) throw new Error("at most 16 reasons");
  for (const r of p.reasons) {
    if (!/^[A-Z0-9_]{1,40}(:[a-z0-9_.:>-]{1,80})?$/.test(r)) throw new Error(`invalid reason "${r}"`);
  }
  if (/[|,\s]/.test(p.route_id) || p.route_id.length > 128) throw new Error("invalid route_id");
}

// ---------------------------------------------------------------------------
// Keys in NEAR's "ed25519:<base58>" format
// ---------------------------------------------------------------------------

export interface WatcherKey {
  /** "ed25519:<base58 of 32-byte public key>" */
  publicKey: string;
  /** "ed25519:<base58 of 64 bytes: seed || public key>" (same layout NEAR CLI uses) */
  secretKey: string;
}

export function generateWatcherKey(seed?: Uint8Array): WatcherKey {
  const secret = seed ?? ed.utils.randomSecretKey();
  if (secret.length !== 32) throw new Error("seed must be 32 bytes");
  const pub = ed.getPublicKey(secret);
  const full = new Uint8Array(64);
  full.set(secret, 0);
  full.set(pub, 32);
  return { publicKey: `ed25519:${base58Encode(pub)}`, secretKey: `ed25519:${base58Encode(full)}` };
}

export function decodeSecretKey(secretKey: string): Uint8Array {
  const raw = base58Decode(stripCurve(secretKey));
  if (raw.length === 64) return raw.slice(0, 32);
  if (raw.length === 32) return raw;
  throw new Error("secret key must decode to 32 or 64 bytes");
}

export function decodePublicKey(publicKey: string): Uint8Array {
  const raw = base58Decode(stripCurve(publicKey));
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return raw;
}

export function publicKeyFromSecret(secretKey: string): string {
  return `ed25519:${base58Encode(ed.getPublicKey(decodeSecretKey(secretKey)))}`;
}

function stripCurve(key: string): string {
  if (key.startsWith("ed25519:")) return key.slice(8);
  if (key.includes(":")) throw new Error("only ed25519 keys are supported");
  return key;
}

export function signAttestation(contractId: string, payload: VerdictPayload, watcherId: string, secretKey: string): Attestation {
  const msg = utf8ToBytes(attestationMessage(contractId, payload));
  const sig = ed.sign(msg, decodeSecretKey(secretKey));
  return { watcher_id: watcherId, signature: bytesToBase64(sig) };
}

export function verifyAttestation(contractId: string, payload: VerdictPayload, att: Attestation, publicKey: string): boolean {
  try {
    const msg = utf8ToBytes(attestationMessage(contractId, payload));
    return ed.verify(base64ToBytes(att.signature), msg, decodePublicKey(publicKey));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// base58 (Bitcoin alphabet) and base64, dependency-free and browser-safe
// ---------------------------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP.get(s[i]!);
    if (v === undefined) throw new Error(`invalid base58 character "${s[i]}"`);
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes.reverse(), zeros);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? "=" : B64[(n >> 6) & 63]!) + (c === undefined ? "=" : B64[n & 63]!);
  }
  return out;
}

export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v === -1) throw new Error("invalid base64");
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}
