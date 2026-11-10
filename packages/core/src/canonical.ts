import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Canonical JSON for report hashing.
 *
 * Every watcher must turn the same verdict into the same bytes. Rules:
 * - object keys sorted by UTF-16 code unit order, no whitespace
 * - bigint encoded as a decimal string
 * - only safe integers allowed as numbers (floats are rejected: they are a determinism hazard)
 * - undefined object members are dropped; undefined array items are rejected
 */
export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

function encode(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "string":
      return JSON.stringify(v);
    case "bigint":
      return JSON.stringify(v.toString());
    case "number":
      if (!Number.isSafeInteger(v)) throw new Error(`canonicalize: non-integer number at ${path} (${v}); use integers or strings`);
      return Object.is(v, -0) ? "0" : String(v);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v.map((x, i) => {
          if (x === undefined) throw new Error(`canonicalize: undefined array item at ${path}[${i}]`);
          return encode(x, `${path}[${i}]`);
        }).join(",")}]`;
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalize: unsupported type ${typeof v} at ${path}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** JSON.stringify replacer that keeps bigints readable in logs and API responses. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, bigintReplacer, space);
}
