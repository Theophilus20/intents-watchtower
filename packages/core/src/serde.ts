/**
 * Lossless JSON for structures that contain bigints (observations, engine state).
 * bigint 123 <-> "123n". Ordinary strings that happen to look like "123n" are escaped as "\u0000123n".
 */
const BIG = /^-?\d+n$/;

export function encodeJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return `${v.toString()}n`;
      if (typeof v === "string" && (BIG.test(v) || v.startsWith("\u0000"))) return `\u0000${v}`;
      return v;
    },
    space,
  );
}

export function decodeJson<T = unknown>(text: string): T {
  return JSON.parse(text, (_k, v) => {
    if (typeof v === "string") {
      if (v.startsWith("\u0000")) return v.slice(1);
      if (BIG.test(v)) return BigInt(v.slice(0, -1));
    }
    return v;
  }) as T;
}
