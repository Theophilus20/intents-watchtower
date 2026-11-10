import { A } from "./strings-a.ts";
import { B } from "./strings-b.ts";
import { C } from "./strings-c.ts";
import { D } from "./strings-d.ts";
import type { Row } from "./strings-row.ts";

/** Every interface string, keyed by its English text. Split into four files only to keep them readable. */
export const STRINGS: Record<string, Row> = { ...A, ...B, ...C, ...D };
