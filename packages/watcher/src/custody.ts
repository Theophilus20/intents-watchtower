import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_ASSETS } from "@watchtower/core";
import { assetsFromTokens, hotHomeToken, hotTreasury, parseEventLog, EsploraReader, EvmReader, fetchJson, jsonRpc, NearRpc, NeardataIndexer, OneClickClient, PoaBridgeClient, realAddresses, SolanaReader, supplySource, type ChainReader, type HttpOptions, type LiveConfig, type NeardataBlock, type TokenBinding } from "@watchtower/collectors";
import { DEFAULT_LIVE } from "./doctor.ts";

/**
 * Custody finder: works out where a bridge keeps the coins behind its NEAR tokens, from the
 * bridge's own transactions, and measures how much of the NEAR supply those addresses hold.
 *
 *   npm run custody            report only
 *   npm run custody -- --apply also write the result into watchtower.config.json
 *
 * Bridge deposits and withdrawals come from two places: the recent history of each bridge token
 * contract (FastNEAR's transactions API, a few dozen requests in all) and whatever the watchers
 * recorded (data/bridge-events-*.jsonl). From those:
 *   1. withdrawals -> the PoA bridge's withdrawal_status -> the payout transaction on the home
 *      chain -> its sender: a hot wallet
 *   2. deposits -> the home-chain deposit transaction -> the output that matches the credited
 *      amount: a deposit address, then where that address swept its coins: the treasury
 *   3. the hot wallets' own funding (Bitcoin, Litecoin, ERC-20): more treasury candidates
 * Then it adds up their balances and compares with the supply on NEAR.
 *
 * It only proposes custody when the addresses found hold at least the whole supply: anything
 * less could be a missing address rather than a real hole, and a backing check fed with a
 * partial list would raise false alarms. Hot wallets are always safe to use (safe size only).
 */

export type Kind = "esplora" | "evm" | "solana";

export interface BridgeEvent {
  kind: "deposit" | "withdrawal";
  asset: string;
  amount: string;
  account: string;
  nearTx: string;
  atMs: number;
  sourceTxRef?: string;
  sourceChain?: string;
  destAddress?: string;
}

export interface AddressFinding {
  address: string;
  role: "hot wallet" | "deposit address" | "treasury" | "other service" | "unmatched payout";
  /** How it was found, for example "paid 4 withdrawals". */
  evidence: string;
  balance?: string;
}

export interface AssetFinding {
  asset: string;
  decimals: number;
  supply?: string;
  withdrawalsSeen: number;
  withdrawalsTraced: number;
  depositsSeen: number;
  depositsTraced: number;
  addresses: AddressFinding[];
  found?: string;
  coveragePpm?: number;
  /** Coins still sitting in users' own deposit addresses, waiting to be swept. Not used for backing. */
  unswept?: string;
  unsweptAddresses?: number;
  coverageWithUnsweptPpm?: number;
  /** Tokens on NEAR held by the bridge's own accounts: minted or withdrawn, owed to no user. */
  bridgeHeld?: string;
  /** Of bridgeHeld, the part those accounts hold inside the intents contract's ledger. */
  bridgeHeldInsideIntents?: string;
  /** The bridge's own NEAR accounts for this token (the minter, the withdrawal receiver, the contract). */
  issuerAccounts?: string[];
  verdict: "complete" | "partial" | "over" | "no_data";
  notes: string[];
  /**
   * Over the same window, what users withdrew on NEAR against what the hot wallets actually sent:
   * to the addresses those users named, and to addresses no withdrawal named.
   */
  reconciliation?: Reconciliation;
  /**
   * Partly verified: the custody found is the bridge's whole treasury by every test the finder
   * can run, yet holds less than users are owed, by a steady amount. The alarm settings the
   * watchers use, measured from the history. Undefined when the evidence isn't strong enough;
   * `partialRefused` then says why.
   */
  partial?: PartialProposal;
  partialRefused?: string;
  /** Where the asset lives, so --apply can add it to a config that doesn't list it yet. */
  source?: { nearContract: string; mtTokenId?: string; token?: string };
}

export interface PartialProposal {
  baselineGap: string;
  smallGap: string;
  alarmGap: string;
  persistMs: number;
  sinceMs: number;
  measuredAtMs: number;
  /** The largest rise above the usual shortfall seen in the window, and the longest one. */
  maxRaise: string;
  maxRaiseMs: number;
}

/**
 * The shortfall over the window as a step function, from the NEAR mints and burns and the
 * treasury's own transactions, and what it says about normal behaviour: its usual level
 * (time-weighted median), and how far and for how long deposits credited before being swept
 * push it up. Alarm settings follow from those with a margin.
 */
export type GapSegment = { from: number; to: number; gap: bigint };

/** The shortfall as a step function over [fromMs, nowMs], worked back from its value now. */
export function gapSegments(gapNow: bigint, near: { atMs: number; delta: bigint }[], hot: { atMs: number; delta: bigint }[], fromMs: number, nowMs: number): GapSegment[] {
  const evs = [...near.map((x) => ({ atMs: x.atMs, d: x.delta })), ...hot.map((x) => ({ atMs: x.atMs, d: -x.delta }))].filter((e) => e.atMs >= fromMs && e.atMs <= nowMs).sort((a, b) => b.atMs - a.atMs);
  const segs: GapSegment[] = [];
  let g = gapNow;
  let end = nowMs;
  for (const e of evs) {
    segs.push({ from: e.atMs, to: end, gap: g });
    g -= e.d; // the shortfall before this event
    end = e.atMs;
  }
  segs.push({ from: fromMs, to: end, gap: g });
  return segs.filter((x) => x.to > x.from).reverse();
}

/**
 * The time-weighted median shortfall over [a, b]: its usual level there. A moment between a
 * withdrawal leaving NEAR and its payout, or a deposit being credited and swept, doesn't move it.
 */
export function medianGap(segs: GapSegment[], a: number, b: number): bigint | undefined {
  const parts = segs.map((x) => ({ gap: x.gap, ms: Math.min(x.to, b) - Math.max(x.from, a) })).filter((x) => x.ms > 0).sort((x, y) => (x.gap < y.gap ? -1 : x.gap > y.gap ? 1 : 0));
  const total = parts.reduce((t, x) => t + x.ms, 0);
  let acc = 0;
  for (const x of parts) {
    acc += x.ms;
    if (acc * 2 >= total) return x.gap;
  }
  return undefined;
}

export function gapProfile(gapNow: bigint, near: { atMs: number; delta: bigint }[], hot: { atMs: number; delta: bigint }[], fromMs: number, nowMs: number, owed: bigint): Omit<PartialProposal, "sinceMs" | "measuredAtMs"> {
  const timed = gapSegments(gapNow, near, hot, fromMs, nowMs);
  const baseline = medianGap(timed, fromMs, nowMs) ?? gapNow;
  const small = owed / 2000n > 0n ? owed / 2000n : 1n; // 0.05% of what is owed
  // Raised stretches, oldest first: how high, and how long.
  let maxRaise = 0n;
  let maxRaiseMs = 0;
  let runStart: number | undefined;
  for (const x of timed) {
    const raise = x.gap - baseline;
    if (raise > small) {
      runStart ??= x.from;
      if (raise > maxRaise) maxRaise = raise;
      maxRaiseMs = Math.max(maxRaiseMs, x.to - runStart);
    } else runStart = undefined;
  }
  const margin = [(maxRaise * 3n) / 2n, owed / 1000n, small * 2n].reduce((a, b) => (a > b ? a : b));
  return { baselineGap: baseline.toString(), smallGap: small.toString(), alarmGap: (baseline + margin).toString(), persistMs: Math.max(30 * 60_000, Math.round(maxRaiseMs * 1.5)), maxRaise: maxRaise.toString(), maxRaiseMs };
}

export interface Reconciliation {
  fromMs: number;
  withdrawals: number;
  withdrawn: string;
  paidToUsers: string;
  paymentsToUsers?: number;
  /**
   * What users are owed minus what the hot wallets hold, worked back through both histories:
   * a gap that was already there at the start is older than the history; one that grows is live.
   */
  gapTimeline?: { atMs: number; gap: string }[];
  /** The shortfall at the moment of the run (the timeline holds usual levels per stretch). */
  gapNow?: string;
  paidElsewhere: string;
  paymentsElsewhere: number;
}

const HTTP: HttpOptions = { timeoutMs: 15_000, retries: 1 };
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_TRACE = 12;

/**
 * Wallets NEAR Intents itself lists as holding its funds, "for transparency and AML compliance":
 * https://docs.near-intents.org/security-compliance/treasury-addresses (read 9 November 2026).
 * The finder checks each against the asset's chain and counts it as the bridge's own. Omni Bridge
 * change addresses on the same page belong to a different bridge and token, so they are left out.
 */
export const OFFICIAL_TREASURIES: Record<string, { address: string; label: string }[]> = {
  bitcoin: [{ address: "1C6XJtNXiuXvk4oUAVMkKF57CRpaTrN5Ra", label: "treasury" }],
  litecoin: [{ address: "LQjEMkuiA2pCwFeUPwsu6ktzUubBVLsahX", label: "treasury" }, { address: "LVUMGpKvAzC4C8KprqyUDWpk6oPd4rKFV9", label: "refill address" }],
  ethereum: [{ address: "0x2cff890f0378a11913b6129b2e97417a2c302680", label: "treasury" }],
  bsc: [{ address: "0x233c5370ccfb3cd7409d9a3fb98ab94de94cb4cd", label: "HOT Bridge treasury" }],
  solana: [{ address: "HWjmoUNYckccg9Qrwi43JTzBcGcM1nbdAtATf9GXmz16", label: "treasury" }, { address: "8sXzdKW2jFj7V5heRwPMcygzNH3JZnmie5ZRuNoTuKQC", label: "HOT Bridge treasury" }],
};
export const OFFICIAL_TREASURIES_SOURCE = "https://docs.near-intents.org/security-compliance/treasury-addresses";
const MAX_PAYOUT_TRACE = 24;

export interface EsploraTx {
  txid: string;
  status?: { block_time?: number };
  vin: { prevout?: { scriptpubkey_address?: string; value: number } }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

interface SolParsed {
  type?: string;
  info?: { source?: string; destination?: string; authority?: string; multisigAuthority?: string };
}
interface SolTx {
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: { parsed?: SolParsed | string }[] } };
  meta?: { innerInstructions?: { instructions: { parsed?: SolParsed | string }[] }[] };
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const pad = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const unpad = (topic: string) => "0x" + topic.slice(-40);

/** Read every bridge-events file the watchers wrote, without duplicates. */
export function loadBridgeEvents(dir = "data"): BridgeEvent[] {
  if (!existsSync(dir)) return [];
  const seen = new Map<string, BridgeEvent>();
  for (const f of readdirSync(dir).filter((x) => /^bridge-events-.*\.jsonl$/.test(x))) {
    for (const line of readFileSync(`${dir}/${f}`, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as BridgeEvent;
        seen.set(`${e.kind}|${e.asset}|${e.nearTx}|${e.amount}`, e);
      } catch {
        /* a line cut off by a closed window */
      }
    }
  }
  return [...seen.values()].sort((a, b) => b.atMs - a.atMs);
}

/** Home-chain token for a PoA token contract: "eth-0xa0b8….omft.near" -> "0xa0b8…", "sol-<mint>.omft.near" -> mint. */
export function homeToken(nearContract: string): string | undefined {
  const m = /^[a-z]+-([0-9a-zA-Z]{32,64})\.omft\.near$/.exec(nearContract);
  return m?.[1];
}

/** Senders of a payout: the bridge wallet that paid a withdrawal. */
const esplora = new Map<string, EsploraReader>();
let lastExplorerCall = 0;
/**
 * One explorer request, paced (a quarter second apart) and patient: free explorers refuse bursts
 * with HTTP 429, and a refusal means "slow down", not "no answer". Waits 5 s doubling up to a
 * minute, four times, before giving up on that one request.
 */
export const esploraGet = async <T,>(url: string, path: string): Promise<T> => {
  const chain = url.includes("litecoin") ? "litecoin" : "bitcoin";
  if (!esplora.has(url)) esplora.set(url, new EsploraReader(chain, url, HTTP));
  for (let i = 0; ; i++) {
    const wait = lastExplorerCall + 250 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastExplorerCall = Date.now();
    try {
      return await esplora.get(url)!.get<T>(path);
    } catch (e) {
      if (!/\b429\b|Too Many|rate/i.test(String((e as Error).message)) || i >= 4) throw e;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 5_000 * 2 ** i)));
    }
  }
};

async function payoutSenders(kind: Kind, url: string, tx: string): Promise<string[]> {
  if (kind === "esplora") {
    const t = await esploraGet<EsploraTx>(url, `/tx/${tx}`);
    return uniq(t.vin.map((v) => v.prevout?.scriptpubkey_address).filter((x): x is string => !!x));
  }
  if (kind === "evm") {
    const t = await jsonRpc<{ from: string } | null>(url, "eth_getTransactionByHash", [tx], HTTP);
    return t ? [t.from.toLowerCase()] : [];
  }
  const t = await jsonRpc<SolTx | null>(url, "getTransaction", [tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "finalized" }], HTTP);
  if (!t) return [];
  const sources = solTransfers(t).map((x) => x.info?.authority ?? x.info?.multisigAuthority ?? x.info?.source).filter((x): x is string => !!x);
  return uniq(sources.length ? sources : t.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey).slice(0, 1));
}

function solTransfers(t: SolTx): SolParsed[] {
  const all = [...t.transaction.message.instructions, ...(t.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  return all.map((i) => i.parsed).filter((p): p is SolParsed => typeof p === "object" && !!p && /^transfer/.test(p.type ?? ""));
}

/** The deposit address in a user's deposit: the output that carries exactly the credited amount. */
export async function depositRecipient(kind: Kind, url: string, tx: string, amount: bigint, token?: string): Promise<string | undefined> {
  if (kind === "esplora") {
    const t = await esploraGet<EsploraTx>(url, `/tx/${tx}`);
    // The output carrying the credited amount: exact, or up to 1% more when the bridge took a fee.
    const outs = t.vout.filter((o) => o.scriptpubkey_address && BigInt(o.value) >= amount && BigInt(o.value) * 100n <= amount * 101n);
    outs.sort((x, y) => x.value - y.value);
    return outs[0]?.scriptpubkey_address;
  }
  if (kind === "evm") {
    const hash = tx.startsWith("0x") ? tx : `0x${tx}`;
    if (!token) {
      const t = await jsonRpc<{ to: string | null; value: string } | null>(url, "eth_getTransactionByHash", [hash], HTTP);
      return t?.to && BigInt(t.value) === amount ? t.to.toLowerCase() : undefined;
    }
    const r = await jsonRpc<{ logs: { address: string; topics: string[]; data: string }[] } | null>(url, "eth_getTransactionReceipt", [hash], HTTP);
    const log = r?.logs.find((l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && BigInt(l.data) === amount);
    return log ? unpad(log.topics[2]!) : undefined;
  }
  return undefined; // Solana deposits: hot wallets and their balances still count
}

/** Where coins left an address to (Bitcoin-like): sweep destinations of a deposit address. */
async function esploraOutflows(url: string, address: string): Promise<Map<string, bigint>> {
  const txs = await esploraGet<EsploraTx[]>(url, `/address/${address}/txs`);
  const out = new Map<string, bigint>();
  for (const t of txs.slice(0, 25)) {
    if (!t.vin.some((v) => v.prevout?.scriptpubkey_address === address)) continue;
    for (const o of t.vout) if (o.scriptpubkey_address && o.scriptpubkey_address !== address) out.set(o.scriptpubkey_address, (out.get(o.scriptpubkey_address) ?? 0n) + BigInt(o.value));
  }
  return out;
}

/** Where coins came into an address from (Bitcoin-like): who funds a hot wallet. */
/**
 * A Bitcoin-like address's history, newest first, paging back with Esplora's
 * /txs/chain/<last txid> until `pages` pages of 25 confirmed transactions.
 */
export async function esploraHistory(url: string, address: string, pages: number): Promise<EsploraTx[]> {
  const out: EsploraTx[] = [];
  let last: string | undefined;
  for (let p = 0; p < pages; p++) {
    let page: EsploraTx[];
    try {
      page = await esploraGet<EsploraTx[]>(url, last ? `/address/${address}/txs/chain/${last}` : `/address/${address}/txs/chain`);
    } catch (e) {
      if (!out.length) throw e;
      break; // keep what was read: a busy server shouldn't throw away the pages before it
    }
    if (!page.length) break;
    out.push(...page);
    last = page[page.length - 1]!.txid;
    if (page.length < 25) break;
    await pause(150);
  }
  return out;
}

/**
 * Who a hot wallet trades coins with, beyond user payouts: addresses that refill it, and whether
 * it also sends to them. A cold wallet refills the hot one (and often takes its excess back); a
 * swept user deposit address sends once and ends up empty.
 */
function esploraCounterparties(txs: EsploraTx[], hot: string): Map<string, { inflow: bigint; outflow: bigint }> {
  const m = new Map<string, { inflow: bigint; outflow: bigint }>();
  const get = (a: string) => m.get(a) ?? m.set(a, { inflow: 0n, outflow: 0n }).get(a)!;
  for (const t of txs) {
    const spends = t.vin.some((v) => v.prevout?.scriptpubkey_address === hot);
    if (!spends) {
      const value = t.vout.filter((o) => o.scriptpubkey_address === hot).reduce((x, o) => x + BigInt(o.value), 0n);
      for (const a of uniq(t.vin.map((v) => v.prevout?.scriptpubkey_address).filter((x): x is string => !!x))) get(a).inflow += value;
    } else {
      for (const o of t.vout) if (o.scriptpubkey_address && o.scriptpubkey_address !== hot) get(o.scriptpubkey_address).outflow += BigInt(o.value);
    }
  }
  return m;
}

/** Bech32 addresses are case-insensitive; base58 ones are not. */
const sameAddress = (a: string) => (/^(bc1|tb1|ltc1|tltc1)/i.test(a) ? a.toLowerCase() : a);

/**
 * Every coin the hot wallets sent since `fromMs`, split into payments to an address some NEAR
 * withdrawal named and payments to addresses none did. Moves between the hot wallets themselves
 * are internal and not counted.
 */
export function reconcilePayouts(txs: EsploraTx[], hots: Set<string>, payees: Set<string>, fromMs: number): { toUsers: bigint; toUsersPayments: number; elsewhere: Map<string, { value: bigint; payments: number }> } {
  const own = new Set([...hots].map(sameAddress));
  const named = new Set([...payees].map(sameAddress));
  let toUsers = 0n;
  let toUsersPayments = 0;
  const elsewhere = new Map<string, { value: bigint; payments: number }>();
  const seen = new Set<string>();
  for (const t of txs) {
    if (seen.has(t.txid) || !t.status?.block_time || t.status.block_time * 1000 < fromMs) continue;
    seen.add(t.txid);
    if (!t.vin.some((v) => v.prevout?.scriptpubkey_address && own.has(sameAddress(v.prevout.scriptpubkey_address)))) continue;
    for (const o of t.vout) {
      const to = o.scriptpubkey_address;
      if (!to || own.has(sameAddress(to))) continue;
      if (named.has(sameAddress(to))) { toUsers += BigInt(o.value); toUsersPayments++; }
      else {
        const x = elsewhere.get(to) ?? { value: 0n, payments: 0 };
        x.value += BigInt(o.value);
        x.payments++;
        elsewhere.set(to, x);
      }
    }
  }
  return { toUsers, toUsersPayments, elsewhere };
}

/** How much each hot-wallet transaction since `fromMs` changed the hot wallets' combined balance (fees included). */
export function hotFlows(txs: EsploraTx[], hots: Set<string>, fromMs: number): { atMs: number; delta: bigint }[] {
  const own = new Set([...hots].map(sameAddress));
  const mine = (a?: string) => !!a && own.has(sameAddress(a));
  const seen = new Set<string>();
  const out: { atMs: number; delta: bigint }[] = [];
  for (const t of txs) {
    if (seen.has(t.txid) || !t.status?.block_time || t.status.block_time * 1000 < fromMs) continue;
    seen.add(t.txid);
    const delta = t.vout.filter((o) => mine(o.scriptpubkey_address)).reduce((x, o) => x + BigInt(o.value), 0n) - t.vin.filter((v) => mine(v.prevout?.scriptpubkey_address)).reduce((x, v) => x + BigInt(v.prevout!.value), 0n);
    out.push({ atMs: t.status.block_time * 1000, delta });
  }
  return out;
}

/** ERC-20 transfers into or out of an address over recent blocks (public RPCs cap the range, so step back in windows). */
async function erc20Counterparties(url: string, token: string, address: string, direction: "in" | "out"): Promise<Map<string, bigint>> {
  const head = Number(BigInt(await jsonRpc<string>(url, "eth_blockNumber", [], HTTP)));
  const out = new Map<string, bigint>();
  const topics = direction === "in" ? [TRANSFER_TOPIC, null, pad(address)] : [TRANSFER_TOPIC, pad(address)];
  for (let to = head, i = 0; i < 6 && to > 0; i++, to -= 5_000) {
    try {
      const logs = await jsonRpc<{ topics: string[]; data: string }[]>(url, "eth_getLogs", [{ address: token, topics, fromBlock: `0x${Math.max(0, to - 4_999).toString(16)}`, toBlock: `0x${to.toString(16)}` }], HTTP);
      for (const l of logs) {
        const other = unpad(l.topics[direction === "in" ? 1 : 2]!);
        out.set(other, (out.get(other) ?? 0n) + BigInt(l.data));
      }
    } catch {
      break; // range or rate limit: keep what we have
    }
  }
  return out;
}

export const TX_API = "https://tx.main.fastnear.com/v0";
export const TX_HTTP: HttpOptions = { timeoutMs: 20_000, retries: 1, ...(process.env.FASTNEAR_API_KEY ? { headers: { authorization: `Bearer ${process.env.FASTNEAR_API_KEY}` } } : {}) };
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** FastNEAR's free tier answers 429 when busy: wait 5, 10 then 20 seconds before giving up. */
export async function patiently<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      // Rate limits and dropped connections pass; anything else is a real answer.
      const transient = (e as { status?: number }).status === 429 || /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|timed? ?out|\b429\b|\b50[234]\b/i.test(String((e as Error).message));
      if (!transient || i >= 4) throw e;
      await pause(5_000 * 2 ** i);
    }
  }
}

interface TxOutcome { id: string; executor_id: string; logs: string[] }

/** Every execution outcome inside a transactions-API row, whatever the exact nesting. */
export function outcomesOf(tx: unknown): TxOutcome[] {
  const out = new Map<string, TxOutcome>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 8) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    const o = v as { id?: string; outcome?: { executor_id?: string; logs?: unknown } };
    if (o.outcome && typeof o.outcome.executor_id === "string" && Array.isArray(o.outcome.logs)) {
      const key = `${o.id ?? ""}|${o.outcome.executor_id}|${o.outcome.logs.length}`;
      out.set(key, { id: o.id ?? key, executor_id: o.outcome.executor_id, logs: o.outcome.logs as string[] });
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(tx, 0);
  return [...out.values()];
}

/**
 * Recent bridge mints and burns straight from each token contract's history (FastNEAR's
 * transactions API), read with the same parser the watchers use. Two queries per contract,
 * because the API's event filter matches accounts *named* in an event:
 *   - withdrawals: events naming the contract (a PoA burn is of tokens the contract itself holds)
 *   - deposits: transactions sent to the contract (the bridge's mint calls land there)
 */
export async function historyEvents(bindings: TokenBinding[], intentsContract: string, perPage = 100, log: (s: string) => void = () => undefined, maxPages = 4, bridgeAccounts?: Map<string, Set<string>>, deepDeposits?: number): Promise<BridgeEvent[]> {
  const indexer = new NeardataIndexer(undefined, bindings, intentsContract);
  const events: BridgeEvent[] = [];
  const done = new Set<string>();
  for (const contract of [...new Set(bindings.map((b) => b.contract))]) {
    const before = events.length;
    const count = (k: BridgeEvent["kind"]) => events.slice(before).filter((e) => e.kind === k).length;
    // Which events the contract itself logged, so a result like "0 deposits" explains itself,
    // and one real example of each (a bridge's exact format is what decides how to read it).
    const kinds = new Map<string, number>();
    const examples = new Map<string, string>();
    let scanned = 0;
    const passes: { want: BridgeEvent["kind"]; filter: Record<string, boolean> }[] = [
      { want: "withdrawal", filter: { is_event_log: true } },
      { want: "deposit", filter: { is_real_receiver: true } },
    ];
    try {
      for (const pass of passes) {
        let resume: string | undefined;
        const deep = pass.want === "deposit" && !!deepDeposits;
        const target = deep ? deepDeposits! : 12;
        const pages = deep ? Math.max(maxPages, Math.ceil(deepDeposits! / 50) + 2) : maxPages;
        for (let page = 0; page < pages; page++) {
          const list = await patiently(() => fetchJson<{ account_txs: { transaction_hash: string; tx_block_height: number; tx_block_timestamp: string }[]; resume_token?: string }>(`${TX_API}/account`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ account_id: contract, ...pass.filter, is_success: true, desc: true, limit: perPage, ...(resume ? { resume_token: resume } : {}) }),
          }, TX_HTTP));
          const rows = (list.account_txs ?? []).filter((r) => !done.has(r.transaction_hash));
          scanned += rows.length;
          resume = list.resume_token || undefined;
          for (let i = 0; i < rows.length; i += 20) {
            const chunk = rows.slice(i, i + 20);
            await pause(400);
            const r = await patiently(() => fetchJson<{ transactions: unknown[] }>(`${TX_API}/transactions`, {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx_hashes: chunk.map((x) => x.transaction_hash) }),
            }, TX_HTTP));
            for (const [k, tx] of (r.transactions ?? []).entries()) {
              const row = chunk.find((x) => JSON.stringify(tx).includes(x.transaction_hash)) ?? chunk[k];
              if (!row || done.has(row.transaction_hash)) continue;
              done.add(row.transaction_hash);
              for (const o of outcomesOf(tx)) {
                if (o.executor_id !== contract) continue;
                for (const l of o.logs) {
                  const ev = parseEventLog(l);
                  if (!ev) continue;
                  kinds.set(ev.event, (kinds.get(ev.event) ?? 0) + 1);
                  if (!examples.has(ev.event)) examples.set(ev.event, JSON.stringify(ev.data[0] ?? {}).slice(0, 220));
                  // Remember the bridge's own accounts: who mints, who hands deposits on, who receives withdrawals.
                  if (bridgeAccounts) {
                    const mine = bridgeAccounts.get(contract) ?? new Set<string>();
                    for (const d of ev.data as { owner_id?: string; old_owner_id?: string; new_owner_id?: string; memo?: string }[]) {
                      if (ev.event === "ft_mint" && d.owner_id) mine.add(d.owner_id);
                      if (ev.event === "ft_transfer" && d.memo?.startsWith("BRIDGED_FROM:") && d.old_owner_id) mine.add(d.old_owner_id);
                      if (ev.event === "ft_transfer" && d.memo?.startsWith("WITHDRAW_TO:") && d.new_owner_id) mine.add(d.new_owner_id);
                    }
                    mine.delete(intentsContract);
                    if (mine.size) bridgeAccounts.set(contract, mine);
                  }
                }
              }
              const ts = String(row.tx_block_timestamp);
              const block: NeardataBlock = {
                block: { header: { height: row.tx_block_height, timestamp_nanosec: ts.length >= 16 ? ts : String(BigInt(ts) * 1_000_000n), hash: "" } },
                shards: [{ receipt_execution_outcomes: outcomesOf(tx).map((o) => ({ receipt: { receiver_id: o.executor_id, predecessor_id: "", receipt_id: o.id }, execution_outcome: { id: o.id, outcome: { logs: o.logs, executor_id: o.executor_id, status: null } }, tx_hash: row.transaction_hash })) }],
              };
              const ib = indexer.parse(block);
              for (const c of ib.credits) events.push({ kind: "deposit", asset: c.asset, amount: c.amount.toString(), account: c.account, nearTx: c.nearTx, atMs: c.atMs, sourceTxRef: c.sourceTxRef, sourceChain: c.sourceChain });
              for (const w of ib.withdrawals) events.push({ kind: "withdrawal", asset: w.asset, amount: w.amount.toString(), account: w.account, nearTx: w.nearTx, atMs: w.atMs, destAddress: w.destAddress });
            }
          }
          await pause(400);
          if (deep) log(`${contract}: ${count("deposit")} deposits read so far`);
          if (count(pass.want) >= target || !resume || !(list.account_txs ?? []).length) break;
        }
      }
    } catch (e) {
      log(`${contract}: history partly unavailable (${String((e as Error).message).slice(0, 80)})`);
    }
    const seen = [...kinds].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k} ${n}`).join(", ");
    log(`${contract}: ${scanned} recent transactions read, ${count("deposit")} deposits and ${count("withdrawal")} withdrawals${seen ? ` (events logged: ${seen})` : " (no events logged by the contract itself)"}`);
    for (const [k, ex] of examples) log(`    example ${k}: ${ex}`);
  }
  return events;
}

/** The PoA bridge's chain id ("btc:mainnet") for a token contract, from its supported_tokens list. */
const poaChains = new Map<string, string | undefined>();
async function poaChainOf(poa: PoaBridgeClient, nearContract: string): Promise<string | undefined> {
  if (!poaChains.size) {
    for (const t of await poa.supportedTokens()) {
      const contract = t.near_token_id.replace(/^nep141:/, "");
      const parts = t.defuse_asset_identifier.split(":");
      if (parts.length >= 2) poaChains.set(contract, `${parts[0]}:${parts[1]}`);
    }
  }
  return poaChains.get(nearContract);
}

const top = (m: Map<string, bigint>, n: number) => [...m].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, n);

export async function findCustody(opts: { configPath?: string; dir?: string; log?: (s: string) => void; history?: boolean; only?: string[]; /** Trace this many deposits to their deposit addresses, to measure coins not yet swept. */ deep?: number; /** Read NEAR history back this many deposits (and hot wallets 1,000 transactions back) without tracing each deposit. */ historyDepth?: number } = {}): Promise<AssetFinding[]> {
  const wanted = (key: string) => !opts.only?.length || opts.only.includes(key);
  const log = opts.log ?? (() => undefined);
  const path = opts.configPath ?? "watchtower.config.json";
  const file = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { live?: LiveConfig }) : {};
  const live: LiveConfig = { ...DEFAULT_LIVE, ...(file.live ?? {}), near: { ...DEFAULT_LIVE.near, ...(file.live?.near ?? {}) }, chains: { ...DEFAULT_LIVE.chains, ...(file.live?.chains ?? {}) } };
  const near = new NearRpc(live.near.rpcUrl, HTTP);
  const poa = new PoaBridgeClient(undefined, HTTP);
  // Where each bridged asset's NEAR token lives: config, then the built-in list, then 1Click.
  const tokenIds = new Map<string, { nearContract: string; mtTokenId?: string }>();
  let byTokenId = new Map<string, string>();
  try {
    byTokenId = assetsFromTokens(await new OneClickClient(live.oneClickUrl, HTTP).tokens()).byTokenId;
  } catch {
    /* fall back to config and built-in token ids */
  }
  for (const a of DEFAULT_ASSETS) {
    if (a.bridge === "native" || !wanted(a.key)) continue;
    const cfg = live.assets[a.key];
    const id = a.nearTokenId ?? [...byTokenId].find(([, k]) => k === a.key)?.[0];
    const src = cfg ? { nearContract: cfg.nearContract, mtTokenId: cfg.mtTokenId } : id ? supplySource(id) : undefined;
    if (src) tokenIds.set(a.key, src);
  }
  const recorded = loadBridgeEvents(opts.dir);
  const bridgeAccounts = new Map<string, Set<string>>();
  const fromHistory = opts.history === false ? [] : await historyEvents([...tokenIds].map(([asset, s]) => ({ contract: s.nearContract, mtTokenId: s.mtTokenId, asset, chain: asset.split(":")[1]! })), live.near.intentsContract, 100, log, 4, bridgeAccounts, opts.deep ?? opts.historyDepth);
  const seen = new Set<string>();
  const events = [...recorded, ...fromHistory].filter((e) => {
    const k = `${e.kind}|${e.asset}|${e.nearTx}|${e.amount}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => b.atMs - a.atMs);
  const findings: AssetFinding[] = [];

  for (const a of DEFAULT_ASSETS) {
    if (a.bridge === "native" || !wanted(a.key)) continue;
    const cfg = live.assets[a.key];
    const chain = live.chains[a.chain];
    const f: AssetFinding = { asset: a.key, decimals: a.decimals, withdrawalsSeen: 0, withdrawalsTraced: 0, depositsSeen: 0, depositsTraced: 0, addresses: [], verdict: "no_data", notes: [] };
    findings.push(f);
    if (!chain) { f.notes.push(`no ${a.chain} endpoint configured`); continue; }
    const kind = chain.kind as Kind;
    const src = tokenIds.get(a.key);
    const hot = a.bridge === "hot" && src?.mtTokenId ? hotHomeToken(src.mtTokenId) : undefined;
    const token = cfg?.token ?? (src ? homeToken(src.nearContract) ?? hot?.token : undefined);
    if (src) f.source = { ...src, ...(token ? { token } : {}) };
    log(`${a.key}: tracing`);

    try {
      if (src) f.supply = (await patiently(async () => (src.mtTokenId ? BigInt(await near.view<string>(src.nearContract, "mt_supply", { token_id: src.mtTokenId })) : await near.ftTotalSupply(src.nearContract)))).toString();
    } catch {
      f.notes.push("couldn't read the supply on NEAR");
    }

    const add = (address: string, role: AddressFinding["role"], evidence: string) => {
      const known = f.addresses.find((x) => x.address === address);
      if (known) return known;
      const x = { address, role, evidence };
      f.addresses.push(x);
      return x;
    };

    // 1. Withdrawals -> payouts -> hot wallets.
    const ws = events.filter((e) => e.asset === a.key && e.kind === "withdrawal");
    f.withdrawalsSeen = ws.length;
    const payers = new Map<string, number>();
    let traceErr: string | undefined;
    if (a.bridge === "poa") {
      // Spread the sample over the whole list: a second payout wallet used now and then still shows up.
      const step = Math.max(1, Math.floor(ws.length / MAX_PAYOUT_TRACE));
      for (const w of ws.filter((_, i) => i % step === 0).slice(0, MAX_PAYOUT_TRACE)) {
        try {
          const st = await poa.withdrawalStatus(w.nearTx);
          const payout = st.data?.transfer_tx_hash as string | undefined;
          if (!payout) continue;
          for (const s of await payoutSenders(kind, chain.url, payout)) payers.set(s, (payers.get(s) ?? 0) + 1);
          f.withdrawalsTraced++;
        } catch (e) {
          traceErr ??= (e as Error).message; // bridge or chain lookup failed: try the next one
        }
      }
      if (!f.withdrawalsTraced && traceErr) f.notes.push(`no withdrawal could be traced: ${traceErr.slice(0, 160)}`);
    } else if (a.bridge === "hot" && kind === "evm") {
      // HOT keeps one locker per EVM chain: no per-user addresses, no sweeping. A token sold as an
      // ERC-20 must decode to one, or the locker's native balance would be counted instead.
      const nativeHere = ["bnb", "eth", "pol", "avax"].includes(a.symbol);
      if (!hot) f.notes.push(`couldn't read the home chain from HOT token id ${src?.mtTokenId ?? "(none)"}`);
      else if (!token && !nativeHere) f.notes.push(`HOT token id ${src?.mtTokenId} doesn't name an ERC-20 contract, so its locker balance can't be read`);
      else add(hotTreasury(hot.chainId), "treasury", "HOT bridge's locker on this chain: deposits are paid into it, withdrawals out of it (HOT's omni SDK)");
    } else if (ws.length) {
      f.notes.push(`${a.bridge} bridge payouts can't be looked up through the PoA bridge API yet`);
    }
    for (const [addr, n] of payers) add(addr, "hot wallet", `paid ${n} withdrawal${n === 1 ? "" : "s"}`);

    // 2. Deposits -> deposit addresses -> where they swept to.
    const ds = events.filter((e) => e.asset === a.key && e.kind === "deposit" && e.sourceTxRef);
    f.depositsSeen = events.filter((e) => e.asset === a.key && e.kind === "deposit").length;
    if (f.depositsSeen && !ds.length) f.notes.push("deposits on NEAR don't name their home-chain transaction, so they can't be traced from NEAR alone");
    const depositAddrs: string[] = [];
    const toTrace = ds.slice(0, opts.deep && kind === "esplora" ? opts.deep : MAX_TRACE);
    for (const [i, d] of toTrace.entries()) {
      try {
        const to = await depositRecipient(kind, chain.url, d.sourceTxRef!, BigInt(d.amount), token);
        if (to) { depositAddrs.push(to); f.depositsTraced++; }
      } catch {
        /* next */
      }
      if (toTrace.length > MAX_TRACE) {
        await pause(100);
        if ((i + 1) % 50 === 0) log(`${a.key}: traced ${i + 1} of ${toTrace.length} deposits`);
      }
    }
    for (const d of uniq(depositAddrs)) add(d, "deposit address", "received a user's deposit");

    // 3. Treasury candidates: where deposits swept to, and who funds the hot wallets.
    const sweeps = new Map<string, bigint>();
    const funders = new Map<string, bigint>();
    const twoWay = new Set<string>();
    const hotTxs: EsploraTx[] = [];
    const hotReach: number[] = [];
    let gapFlows: { fromMs: number; near: { atMs: number; delta: bigint }[]; hot: { atMs: number; delta: bigint }[] } | undefined;
    const known = new Set(f.addresses.map((x) => x.address));
    try {
      if (kind === "esplora") {
        for (const d of uniq(depositAddrs).slice(0, 5)) {
          try {
            for (const [k, v] of await esploraOutflows(chain.url, d)) sweeps.set(k, (sweeps.get(k) ?? 0n) + v);
          } catch {
            /* one unreadable deposit address shouldn't stop the rest */
          }
        }
        // Deep search: up to 500 of each hot wallet's transactions for addresses that refill it.
        // Payout recipients are users; deposit addresses are already known. Two-way traffic, or
        // a refill from an address that still holds coins, marks a treasury.
        const payees = new Set(events.filter((e) => e.asset === a.key && e.destAddress).map((e) => e.destAddress!));
        const hots = [...payers.keys()].slice(0, 3);
        for (const h of hots) {
          const txs = await esploraHistory(chain.url, h, opts.deep || opts.historyDepth ? 40 : 20);
          hotTxs.push(...txs);
          const since = txs[txs.length - 1]?.status?.block_time;
          f.notes.push(`looked through ${txs.length} of ${h}'s transactions${since ? ` (back to ${new Date(since * 1000).toISOString().slice(0, 10)})` : ""} for wallets that refill it`);
          hotReach.push(since ? since * 1000 : Date.now());
          for (const [k, v] of esploraCounterparties(txs, h)) {
            if (known.has(k) || payees.has(k) || v.inflow === 0n) continue;
            funders.set(k, (funders.get(k) ?? 0n) + v.inflow);
            if (v.outflow > 0n) twoWay.add(k);
          }
        }
      } else if (kind === "evm" && token) {
        for (const d of uniq(depositAddrs).slice(0, 3)) for (const [k, v] of await erc20Counterparties(chain.url, token, d, "out")) sweeps.set(k, (sweeps.get(k) ?? 0n) + v);
        for (const h of [...payers.keys()].slice(0, 2)) for (const [k, v] of await erc20Counterparties(chain.url, token, h, "in")) if (!known.has(k)) funders.set(k, (funders.get(k) ?? 0n) + v);
      }
    } catch {
      f.notes.push("couldn't follow every sweep and refill; the list may be incomplete");
    }
    for (const [k] of top(sweeps, 5)) if (!known.has(k)) add(k, "treasury", "deposits were swept to it");
    for (const [k, v] of top(funders, kind === "esplora" ? 12 : 5)) {
      if (known.has(k) || sweeps.has(k)) continue;
      add(k, "treasury", twoWay.has(k) ? `refilled the hot wallet with ${units(v.toString(), a.decimals)} and also received from it` : `refilled the hot wallet with ${units(v.toString(), a.decimals)}`);
    }

    // 3a. Reconcile payouts: over the window both histories cover, did the hot wallets send out
    // more than users withdrew? Coins sent to addresses no withdrawal named are where a gap goes.
    if (kind === "esplora" && hotTxs.length) {
      // The withdrawal window comes from the contract's own contiguous history (the watchers' own
      // records skip blocks); payouts for withdrawals just before it would look unmatched, so
      // give it an hour.
      const contiguous = fromHistory.filter((e) => e.asset === a.key && e.kind === "withdrawal");
      const basis = contiguous.length ? contiguous : ws;
      const credits = (fromHistory.some((e) => e.asset === a.key) ? fromHistory : events).filter((e) => e.asset === a.key && e.kind === "deposit");
      // Both NEAR lists must reach back to the window's start: take the later of their oldest entries.
      const oldest = Math.max(Math.min(...basis.map((e) => e.atMs)), credits.length ? Math.min(...credits.map((e) => e.atMs)) : 0);
      const fromMs = Math.max(oldest + 3 * 3_600_000, ...hotReach);
      if (basis.length >= 5 && fromMs < Date.now() - 3_600_000) {
        const payees = new Set(events.filter((e) => e.asset === a.key && e.destAddress).map((e) => e.destAddress!));
        const { toUsers, toUsersPayments, elsewhere } = reconcilePayouts(hotTxs, new Set(payers.keys()), payees, fromMs);
        const inWindow = basis.filter((e) => e.atMs >= fromMs);
        const withdrawn = inWindow.reduce((t, e) => t + BigInt(e.amount), 0n);
        const away = [...elsewhere.values()].reduce((t, x) => t + x.value, 0n);
        f.reconciliation = { fromMs, withdrawals: inWindow.length, withdrawn: withdrawn.toString(), paidToUsers: toUsers.toString(), paymentsToUsers: toUsersPayments, paidElsewhere: away.toString(), paymentsElsewhere: [...elsewhere.values()].reduce((t, x) => t + x.payments, 0) };
        gapFlows = {
          fromMs,
          near: [...credits.filter((e) => e.atMs >= fromMs).map((e) => ({ atMs: e.atMs, delta: BigInt(e.amount) })), ...inWindow.map((e) => ({ atMs: e.atMs, delta: -BigInt(e.amount) }))],
          hot: hotFlows(hotTxs, new Set(payers.keys()), fromMs),
        };
        const ranked = [...elsewhere].sort((x, y) => (y[1].value > x[1].value ? 1 : y[1].value < x[1].value ? -1 : 0)).slice(0, 8);
        for (const [addr, x] of ranked) {
          if (f.addresses.some((y) => y.address === addr)) continue;
          add(addr, "unmatched payout", `received ${units(x.value.toString(), a.decimals)} from the hot wallet in ${x.payments} payment${x.payments === 1 ? "" : "s"}; no NEAR withdrawal named it`);
        }
      }
    }

    // 3c. NEAR Intents' own published wallets for this chain. Bitcoin-like chains only: there the
    // bridge's PoA treasury and refill wallets hold nothing but this asset, so each counts as its
    // own. On EVM and Solana one wallet holds many tokens for several bridges, so a listed wallet
    // is reported (and marked when it is one we found) but only counted when traced.
    for (const o of OFFICIAL_TREASURIES[a.chain] ?? []) {
      const mine = f.addresses.find((x) => sameAddress(x.address) === sameAddress(o.address));
      if (mine) mine.evidence = `${mine.evidence}; listed by NEAR Intents as its ${o.label}`;
      else if (kind === "esplora" && a.bridge === "poa") add(o.address, "treasury", `listed by NEAR Intents as its ${o.label} (${OFFICIAL_TREASURIES_SOURCE})`);
    }

    // 3b. The bridge gives each user a deposit address and sweeps it later: ask the bridge which
    // addresses it gave recent depositors, so coins not yet swept show up as evidence.
    const userDeposits: string[] = [];
    if (a.bridge === "poa" && src) {
      try {
        // The deposit notes name the chain exactly as the bridge does ("ltc:mainnet"); fall back to its token list.
        const noted = events.find((e) => e.asset === a.key && e.kind === "deposit" && e.sourceChain)?.sourceChain;
        const chainId = noted ?? (await poaChainOf(poa, src.nearContract));
        const all = uniq(events.filter((e) => e.asset === a.key && e.kind === "deposit").map((e) => e.account));
        const depositors = all.filter((x) => x !== live.near.intentsContract && x !== src.nearContract).slice(0, 12);
        if (!chainId) f.notes.push(`the bridge's token list has no chain for ${src.nearContract}, so its deposit addresses can't be looked up`);
        else if (!depositors.length) f.notes.push(`deposits were credited to ${all.slice(0, 3).join(", ") || "nobody"}, not to named users, so the bridge can't be asked for their deposit addresses`);
        else {
          let failed = 0;
          let found = 0;
          for (const acc of depositors) {
            try {
              for (const d of await poa.recentDeposits(acc, chainId)) if (d.address) { userDeposits.push(d.address); found++; }
            } catch {
              failed++;
            }
            await pause(200);
          }
          f.notes.push(`asked the bridge about ${depositors.length} recent depositors on ${chainId}: ${found} deposit records${failed ? `, ${failed} lookups failed` : ""}`);
        }
      } catch (e) {
        f.notes.push(`couldn't ask the bridge for its users' deposit addresses (${String((e as Error).message).slice(0, 80)})`);
      }
    }
    for (const d of uniq(userDeposits)) if (!known.has(d)) add(d, "deposit address", "a user's own deposit address (from the bridge's API)");

    // 4. Balances and coverage.
    const reader: ChainReader = kind === "esplora" ? new EsploraReader(a.chain, chain.url, HTTP) : kind === "evm" ? new EvmReader(a.chain, chain.url, HTTP) : new SolanaReader(chain.url, HTTP);
    let unread = 0;
    let balanceErr: string | undefined;
    for (const [i, x] of f.addresses.entries()) {
      try {
        x.balance = (await reader.balance([x.address], token)).toString();
      } catch (e) {
        balanceErr ??= (e as Error).message;
        if (x.role === "deposit address") unread++;
        else f.notes.push(`couldn't read the balance of ${x.address}`);
      }
      if (f.addresses.length > 40) {
        await pause(100);
        if ((i + 1) % 100 === 0) log(`${a.key}: read ${i + 1} of ${f.addresses.length} balances`);
      }
    }
    if (unread) f.notes.push(`couldn't read the balance of ${unread} deposit address${unread === 1 ? "" : "es"}, so the coins waiting to be swept may be more than shown`);
    if (balanceErr) f.notes.push(`the ${a.chain} explorer answered: ${balanceErr.slice(0, 160)}`);
    // An empty address that fed the hot wallet is most likely a user deposit address that was swept.
    // A refiller left with dust (less than a thousandth of what it sent) is a swept deposit address too.
    for (const x of f.addresses) {
      if (x.role !== "treasury" || x.evidence.includes("listed by NEAR Intents")) continue;
      const sent = funders.get(x.address);
      const dust = 10n ** BigInt(Math.max(0, a.decimals - 4)); // under 0.0001 of a coin
      if (x.balance === "0" || (x.balance !== undefined && (BigInt(x.balance) < dust || (sent !== undefined && BigInt(x.balance) * 1000n < sent)))) { x.role = "deposit address"; x.evidence = `${x.evidence}; now ${x.balance === "0" ? "empty" : "nearly empty"}, likely a swept user deposit address`; }
    }
    // Backing counts only the bridge's own wallets: user deposit addresses change all the time, so a
    // list of them goes out of date within hours. What they hold is reported as evidence for the gap.
    const bal = (x: AddressFinding) => (x.balance ? BigInt(x.balance) : 0n);
    if (!f.addresses.length) {
      f.notes.push(ws.length || ds.length ? "no transaction could be traced yet" : "no bridge activity recorded yet: leave the watchers running longer");
      continue;
    }
    // What users are owed is the supply minus what the bridge itself holds on NEAR.
    let owed = f.supply ? BigInt(f.supply) : 0n;
    if (src && !src.mtTokenId && f.supply) {
      const issuers = uniq([src.nearContract, ...(bridgeAccounts.get(src.nearContract) ?? [])]).filter((x) => x !== live.near.intentsContract);
      let held = 0n;
      for (const acc of issuers) {
        try {
          held += BigInt(await near.view<string>(src.nearContract, "ft_balance_of", { account_id: acc }));
        } catch {
          /* no balance there */
        }
        // The bridge's accounts can hold tokens inside the intents ledger too: owed to no user either.
        try {
          const inside = BigInt(await near.view<string>(live.near.intentsContract, "mt_balance_of", { account_id: acc, token_id: `nep141:${src.nearContract}` }));
          if (inside > 0n) { held += inside; f.bridgeHeldInsideIntents = ((f.bridgeHeldInsideIntents ? BigInt(f.bridgeHeldInsideIntents) : 0n) + inside).toString(); }
        } catch {
          /* no intents balance */
        }
      }
      f.issuerAccounts = issuers;
      if (held > 0n) { f.bridgeHeld = held.toString(); owed = owed > held ? owed - held : 0n; }
    }
    // A refill from a wallet that alone holds far more than users are owed is an exchange or another
    // service paying the bridge, not the bridge's own reserve: counting it would hide a real shortfall.
    if (owed > 0n) {
      for (const x of f.addresses) {
        if (x.role === "treasury" && bal(x) * 2n > owed * 3n) { x.role = "other service"; x.evidence = `${x.evidence}; holds more than 1.5x what users are owed, so likely an exchange, left out`; }
      }
    }
    const sum = f.addresses.filter((x) => x.role === "hot wallet" || x.role === "treasury").reduce((t, x) => t + bal(x), 0n);
    const waiting = f.addresses.filter((x) => x.role === "deposit address" && bal(x) > 0n);
    const unswept = waiting.reduce((t, x) => t + bal(x), 0n);
    if (unswept > 0n) { f.unswept = unswept.toString(); f.unsweptAddresses = waiting.length; }
    f.found = sum.toString();
    if (owed > 0n) {
      f.coveragePpm = Number((sum * 1_000_000n) / owed);
      if (unswept > 0n) f.coverageWithUnsweptPpm = Number(((sum + unswept) * 1_000_000n) / owed);
      f.verdict = f.coveragePpm < 1_000_000 ? "partial" : f.coveragePpm > 1_500_000 ? "over" : "complete";
    }
    // Work the gap back in time: owed then = owed now minus NEAR's net mints since; the hot
    // wallets then = now minus their net flows since.
    if (gapFlows && f.reconciliation && owed > 0n) {
      const hotNow = f.addresses.filter((x) => x.role === "hot wallet").reduce((t, x) => t + bal(x), 0n);
      const gapNow = owed - hotNow;
      const now = Date.now();
      // Five equal stretches of the window, each with its usual (median) shortfall.
      const segs = gapSegments(gapNow, gapFlows.near, gapFlows.hot, gapFlows.fromMs, now);
      const edges = [0, 1, 2, 3, 4, 5].map((k) => gapFlows!.fromMs + Math.round(((now - gapFlows!.fromMs) * k) / 5));
      const timeline = [0, 1, 2, 3, 4].map((k) => ({ atMs: edges[k]!, gap: (medianGap(segs, edges[k]!, edges[k + 1]!) ?? gapNow).toString() }));
      f.reconciliation.gapTimeline = timeline;
      f.reconciliation.gapNow = gapNow.toString();
      // Partly verified needs every test passed: say which one failed otherwise.
      const r = f.reconciliation;
      const first = BigInt(timeline[0]!.gap);
      const lastUsual = BigInt(timeline[timeline.length - 1]!.gap);
      const moved = lastUsual > first ? lastUsual - first : first - lastUsual;
      const abs = gapNow < 0n ? -gapNow : gapNow;
      const tol = (abs > owed / 1000n ? abs : owed / 1000n) / 10n + owed / 1000n;
      const paid = BigInt(r.paidToUsers);
      const withdrawn = BigInt(r.withdrawn);
      const off = paid > withdrawn ? paid - withdrawn : withdrawn - paid;
      const windowMs = now - gapFlows.fromMs;
      if (f.verdict !== "partial") f.partialRefused = undefined;
      else if (f.addresses.some((x) => x.role === "treasury" && bal(x) > 0n)) f.partialRefused = "wallets besides the hot wallet hold coins, and the shortfall history follows only the hot wallet";
      else if ((f.coveragePpm ?? 0) < 900_000) f.partialRefused = "the wallets found hold less than 90% of what users are owed, so a whole wallet is more likely missing than a steady shortfall";
      else if (f.withdrawalsTraced < 10) f.partialRefused = `only ${f.withdrawalsTraced} withdrawals traced to their payer; at least 10 are needed to call it the treasury`;
      // A payout for a withdrawal made just before the window has no match inside it: allow up to
      // 0.5% of what was withdrawn (they are listed); the steady-gap test below catches a real leak.
      else if (BigInt(r.paidElsewhere) * 200n > withdrawn) f.partialRefused = "the hot wallet sent more than 0.5% of what users withdrew to addresses no NEAR withdrawal named";
      else if (off * 100n > withdrawn) f.partialRefused = "what the hot wallet paid users differs from what they withdrew on NEAR by more than 1%";
      else if (windowMs < 24 * 3_600_000 || r.withdrawals < 50) f.partialRefused = `the history covers ${Math.floor(windowMs / 3_600_000)} hours and ${r.withdrawals} withdrawals; at least 24 hours and 50 withdrawals are needed (try --history)`;
      else if (moved > tol) f.partialRefused = "the shortfall changed during the window, so there is no steady level to watch from";
      else f.partial = { ...gapProfile(gapNow, gapFlows.near, gapFlows.hot, gapFlows.fromMs, now, owed), sinceMs: gapFlows.fromMs, measuredAtMs: now };
    }
  }
  return findings;
}

export const units = (v: string | undefined, decimals: number) => (v === undefined ? "?" : (Number(BigInt(v) / 10n ** BigInt(Math.max(0, decimals - 4))) / 10_000).toLocaleString("en-US", { maximumFractionDigits: 4 }));

export function printCustody(fs: AssetFinding[], c: { green: (s: string) => string; yellow: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string }): void {
  for (const f of fs) {
    const sym = f.asset.split(":")[0]!.toUpperCase();
    console.log(`\n${c.bold(f.asset)}  ${units(f.supply, f.decimals)} ${sym} credited on NEAR`);
    if (f.bridgeHeld) console.log(c.dim(`  minus ${units(f.bridgeHeld, f.decimals)} ${sym} held by the bridge's own NEAR accounts (${(f.issuerAccounts ?? []).join(", ")}${f.bridgeHeldInsideIntents ? `; ${units(f.bridgeHeldInsideIntents, f.decimals)} of it inside intents.near` : ""}), which no user is owed: ${units((BigInt(f.supply ?? "0") - BigInt(f.bridgeHeld)).toString(), f.decimals)} ${sym} owed to users`));
    console.log(c.dim(`  withdrawals traced ${f.withdrawalsTraced} of ${f.withdrawalsSeen}, deposits traced ${f.depositsTraced} of ${f.depositsSeen}`));
    const line = (x: AddressFinding) => console.log(`  ${x.role.padEnd(16)} ${x.address}  ${units(x.balance, f.decimals)} ${sym}  ${c.dim(x.evidence)}`);
    const deposits = f.addresses.filter((x) => x.role === "deposit address");
    for (const x of f.addresses) if (x.role !== "deposit address") line(x);
    // Deposit addresses can run to hundreds: show the ones still holding coins, then a count.
    const holding = deposits.filter((x) => x.balance && BigInt(x.balance) > 0n).sort((x, y) => (BigInt(y.balance!) > BigInt(x.balance!) ? 1 : -1));
    for (const x of (deposits.length > 12 ? holding.slice(0, 10) : deposits)) line(x);
    if (deposits.length > 12) {
      const rest = deposits.length - Math.min(holding.length, 10);
      const empty = deposits.length - holding.length;
      console.log(c.dim(`  … and ${rest} more user deposit addresses, ${rest === empty ? "all empty (already swept)" : `${empty} of them empty (already swept)`}`));
    }
    if (f.coveragePpm !== undefined) {
      const pct = (f.coveragePpm / 10_000).toFixed(1);
      const line = `  found ${units(f.found, f.decimals)} ${sym}, ${pct}% of what users are owed`;
      console.log(f.verdict === "complete" ? c.green(`${line}: complete, these addresses can prove backing`) : f.verdict === "over" ? c.yellow(`${line}: more than the supply, so some addresses likely hold other funds; not used for backing`) : c.yellow(`${line}: incomplete, so backing stays unverified (a partial list would raise false alarms)`));
    }
    if (f.unswept) {
      const withPct = ((f.coverageWithUnsweptPpm ?? 0) / 10_000).toFixed(1);
      console.log(c.dim(`  plus ${units(f.unswept, f.decimals)} ${sym} still in ${f.unsweptAddresses} user deposit address${f.unsweptAddresses === 1 ? "" : "es"} waiting to be swept: ${withPct}% with them (evidence for the gap, not used for backing)`));
    }
    if (f.reconciliation) {
      const r = f.reconciliation;
      const when = new Date(r.fromMs).toISOString().slice(0, 16).replace("T", " ");
      const head = `  since ${when} UTC, users withdrew ${units(r.withdrawn, f.decimals)} ${sym} on NEAR (${r.withdrawals} withdrawals); the hot wallet paid ${units(r.paidToUsers, f.decimals)} ${sym}${r.paymentsToUsers !== undefined ? ` in ${r.paymentsToUsers} payments` : ""} to the addresses they named`;
      console.log(BigInt(r.paidElsewhere) > 0n ? c.yellow(`${head}, and ${units(r.paidElsewhere, f.decimals)} ${sym} in ${r.paymentsElsewhere} payment${r.paymentsElsewhere === 1 ? "" : "s"} to addresses no withdrawal named (the "unmatched payout" lines)`) : c.green(`${head}, and nothing anywhere else`));
      if (r.gapTimeline?.length) {
        const g = r.gapTimeline;
        const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const first = BigInt(g[0]!.gap);
        const last = BigInt(g[g.length - 1]!.gap);
        const owed = BigInt(f.supply ?? "0") - BigInt(f.bridgeHeld ?? "0");
        const moved = last > first ? last - first : first - last;
        const tol = [last < 0n ? -last : last, owed / 1000n].reduce((x, y) => (x > y ? x : y)) / 10n + owed / 1000n;
        const trend = moved <= tol ? `Steady: it was already there on ${day(g[0]!.atMs)}, so it is older than this history.` : last > first ? `It grew by ${units(moved.toString(), f.decimals)} ${sym} since ${day(g[0]!.atMs)}.` : `It shrank by ${units(moved.toString(), f.decimals)} ${sym} since ${day(g[0]!.atMs)}.`;
        const show = (v: string) => units(v.startsWith("-") ? "0" : v, f.decimals);
        const line = `  usual gap between what users are owed and what the hot wallet holds, from ${g.map((x) => `${day(x.atMs)}: ${show(x.gap)}`).join(", ")} ${sym}${r.gapNow ? `; right now ${show(r.gapNow)} ${sym}` : ""}. ${trend}`;
        console.log(moved <= tol || last < first ? line : c.yellow(line));
      }
    }
    if (f.partial) {
      const x = f.partial;
      const u = (v: string) => `${units(v, f.decimals)} ${sym}`;
      const raised = BigInt(x.baselineGap) + BigInt(x.smallGap);
      console.log(c.green(`  partly verified: yes. The usual shortfall is ${u(x.baselineGap)}; deposits credited before being moved into the treasury raised it by up to ${u(x.maxRaise)} for up to ${duration(x.maxRaiseMs)}.`));
      console.log(c.green(`    The watchers would go red at once above ${u(x.alarmGap)}, or if it stays above ${u(raised.toString())} for longer than ${duration(x.persistMs)}. Never green while short.`));
      console.log(c.dim(`    use it: npm run custody:apply -- --partial --history --only ${f.asset}`));
    } else if (f.partialRefused) console.log(c.dim(`  partly verified: no, ${f.partialRefused}`));
    for (const n of uniq(f.notes)) console.log(c.dim(`  ${n}`));
  }
}

function duration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 120) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/** Write what was found into the config: hot wallets always, custody only when complete. */
export function applyCustody(fs: AssetFinding[], configPath = "watchtower.config.json", opts: { partial?: boolean } = {}): string[] {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { live: LiveConfig };
  const changed: string[] = [];
  for (const f of fs) {
    const a = DEFAULT_ASSETS.find((x) => x.key === f.asset)!;
    // A HOT Bridge locker pays withdrawals itself: it is the payout wallet too, so the safe size
    // can use its balance and a sudden drain of it raises the hot-wallet alarm.
    const hot = f.addresses.filter((x) => x.role === "hot wallet" || (a.bridge === "hot" && f.verdict === "complete" && x.role === "treasury" && x.evidence.startsWith("HOT bridge's locker"))).map((x) => x.address);
    if (!hot.length && f.verdict !== "complete") continue;
    const existing = cfg.live.assets[f.asset];
    const src = existing ? { nearContract: existing.nearContract, mtTokenId: existing.mtTokenId } : f.source ?? (a.nearTokenId ? supplySource(a.nearTokenId) : undefined);
    if (!src) continue;
    const token = f.source?.token ?? homeToken(src.nearContract);
    const entry = existing ?? { custody: [], nearContract: src.nearContract, ...(src.mtTokenId ? { mtTokenId: src.mtTokenId } : {}), ...(token ? { token } : {}) };
    // Custody is read with the asset's token contract: never write custody without it for an ERC-20.
    if (!entry.token && token) entry.token = token;
    entry.hotWallets = uniq([...realAddresses(entry.hotWallets), ...hot]);
    // The watchers must subtract the same bridge-held tokens, or they'd see a gap the finder doesn't.
    if (f.verdict === "complete" && f.bridgeHeld && f.issuerAccounts?.length) entry.issuerAccounts = f.issuerAccounts;
    const own = f.addresses.filter((x) => (x.role === "hot wallet" || x.role === "treasury") && x.balance && BigInt(x.balance) > 0n).map((x) => x.address);
    const partly = opts.partial && f.verdict === "partial" && f.partial;
    if (f.verdict === "complete") {
      entry.custody = uniq([...realAddresses(entry.custody), ...own]);
      delete entry.partial; // fully covered now: judged like any other asset
    } else if (partly) {
      // Exactly the wallets the shortfall was measured against, so the watchers see what the finder saw.
      entry.custody = uniq(own);
      entry.partial = { baselineGap: f.partial!.baselineGap, smallGap: f.partial!.smallGap, alarmGap: f.partial!.alarmGap, persistMs: f.partial!.persistMs, sinceMs: f.partial!.sinceMs, measuredAtMs: f.partial!.measuredAtMs };
      if (f.issuerAccounts?.length && f.bridgeHeld) entry.issuerAccounts = f.issuerAccounts;
    } else entry.custody = realAddresses(entry.custody);
    cfg.live.assets[f.asset] = entry;
    changed.push(`${f.asset}: ${hot.length} hot wallet${hot.length === 1 ? "" : "s"}${f.verdict === "complete" ? `, ${entry.custody.length} custody addresses` : partly ? `, partly verified: ${entry.custody.length} treasury address${entry.custody.length === 1 ? "" : "es"}, red if the shortfall grows` : ", custody left unverified"}`);
  }
  if (changed.length) {
    copyFileSync(configPath, `${configPath}.bak`);
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  }
  return changed;
}
