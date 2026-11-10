/**
 * Cross-language test vectors: the TypeScript watcher signs, the Rust contract verifies.
 * Regenerate with `npm run vectors`; contracts/watchtower/src/tests.rs consumes the output.
 */
import { writeFileSync } from "node:fs";
import { attestationMessage, generateWatcherKey, hashCanonical, signAttestation, type VerdictPayload } from "@watchtower/core";

const CONTRACT = "watchtower.near";
const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
const watchers = seeds.map((seed, i) => ({ account_id: `w${i + 1}.watchtower.near`, seed_hex: Buffer.from(seed).toString("hex"), ...generateWatcherKey(seed) }));
const epoch = 29_843_520;
const cases: { name: string; route_id: string; report: VerdictPayload; message: string; attestations: ReturnType<typeof signAttestation>[] }[] = [];
const add = (name: string, p: VerdictPayload, signers: number[]) => {
  cases.push({ name, route_id: p.route_id, report: p, message: attestationMessage(CONTRACT, p), attestations: signers.map((i) => signAttestation(CONTRACT, p, watchers[i]!.account_id, watchers[i]!.secretKey)) });
};
add("green-quorum", { route_id: "btc:bitcoin->usdc:near", epoch, status: "green", score: 100, capacity_usd: 250_000, reasons: [], report_hash: hashCanonical({ case: "green" }) }, [0, 1]);
add("red-ghost-credit", { route_id: "usdt:bsc->usdc:near", epoch, status: "red", score: 18, capacity_usd: 0, reasons: ["GHOST_CREDIT_WITHDRAWN:usdt:bsc", "FRESH_ACCOUNT_EXIT:usdt:bsc"], report_hash: hashCanonical({ case: "red" }) }, [2]);
add("amber-concentrated", { route_id: "ltc:litecoin->btc:bitcoin", epoch, status: "amber", score: 72, capacity_usd: 12_000, reasons: ["SOLVER_CONCENTRATED:ltc:litecoin->btc:bitcoin"], report_hash: hashCanonical({ case: "amber" }) }, [0, 1, 2]);

const out = { contract_id: CONTRACT, epoch_ms: 60_000, watchers: watchers.map(({ account_id, publicKey, seed_hex }) => ({ account_id, public_key: publicKey, seed_hex })), cases };
const outIdx = process.argv.indexOf("--out");
const path = outIdx >= 0 ? process.argv[outIdx + 1]! : "test-vectors/attestation.json";
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${cases.length} cases to ${path}`);
