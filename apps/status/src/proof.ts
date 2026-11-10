/**
 * Backing, checked by the page itself.
 *
 * The contract stores each route's verdict, not the numbers behind it. So the page reads the
 * same public data the watchers read: each bridged token's supply on NEAR (minus what the
 * bridge's own accounts hold) and the balances of the wallets the custody finder found. Anyone
 * opening the page gets the backing straight from the chains, without trusting the watchers.
 *
 * The wallet list is public on-chain data copied from watchtower.config.json when the page is
 * built (`npm run app` with WATCHTOWER_LIVE set); nothing secret is in it.
 */
import { EsploraReader, EvmReader, NearRpc, SolanaReader, bridgeHeld, type ChainReader } from "@watchtower/collectors";

export interface ProofAsset {
  chain: string;
  decimals: number;
  custody: string[];
  token?: string;
  nearContract: string;
  mtTokenId?: string;
  issuerAccounts?: string[];
  /** Partly verified: custody is the whole treasury but holds less than is owed. */
  partial?: boolean;
}

export interface ProofConfig {
  nearRpc: string;
  chains: Record<string, { kind: "esplora" | "evm" | "solana"; url: string }>;
  assets: Record<string, ProofAsset>;
}

export interface AssetBacking {
  asset: string;
  /** Custody ÷ what users are owed, parts per million; null when it couldn't be read. */
  ppm: number | null;
  owed?: bigint;
  held?: bigint;
  /** Owed minus held, when positive. */
  short?: bigint;
  partial?: boolean;
  decimals: number;
  error?: string;
}

declare const __WT_PROOF__: ProofConfig | null | undefined;
export const PROOF: ProofConfig | null = typeof __WT_PROOF__ === "object" && __WT_PROOF__ ? __WT_PROOF__ : null;

const HTTP = { timeoutMs: 15_000, retries: 1 };

/**
 * Second endpoints, tried when the configured one refuses a browser. Solana's public RPC limits
 * browsers hard; PublicNode serves the same data and allows pages like this one.
 */
export const BROWSER_FALLBACKS: Record<string, string[]> = {
  solana: ["https://solana-rpc.publicnode.com"],
  ethereum: ["https://eth.llamarpc.com"],
  bsc: ["https://bsc-dataseed.bnbchain.org"],
};

/** Run `fn` against the chain's endpoint, then each fallback, until one answers. */
async function withFallbacks<T>(chain: string, c: { kind: string; url: string }, fn: (r: ChainReader) => Promise<T>): Promise<T> {
  let last: unknown;
  for (const url of [c.url, ...(BROWSER_FALLBACKS[chain] ?? [])]) {
    try {
      return await fn(reader(chain, { kind: c.kind, url }));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

function reader(chain: string, c: { kind: string; url: string }): ChainReader {
  if (c.kind === "esplora") return new EsploraReader(chain as never, c.url, HTTP);
  if (c.kind === "evm") return new EvmReader(chain as never, c.url, HTTP);
  return new SolanaReader(c.url, HTTP);
}

/** Read every configured asset's backing, a few at a time. */
export async function readBacking(cfg: ProofConfig): Promise<Map<string, AssetBacking>> {
  const near = new NearRpc(cfg.nearRpc, HTTP);
  const out = new Map<string, AssetBacking>();
  const one = async (key: string, a: ProofAsset) => {
    const b: AssetBacking = { asset: key, ppm: null, partial: a.partial, decimals: a.decimals };
    try {
      const chain = cfg.chains[a.chain];
      if (!chain) throw new Error(`no ${a.chain} endpoint`);
      const supply = a.mtTokenId ? BigInt(await near.view<string>(a.nearContract, "mt_supply", { token_id: a.mtTokenId })) : await near.ftTotalSupply(a.nearContract);
      let ownHeld = 0n;
      if (!a.mtTokenId && a.issuerAccounts?.length) {
        const h = await bridgeHeld(near, a.nearContract, a.issuerAccounts);
        ownHeld = h.direct + h.insideIntents;
      }
      const owed = supply - ownHeld;
      const held = await withFallbacks(a.chain, chain, (r) => r.balance(a.custody, a.token));
      b.owed = owed;
      b.held = held;
      b.ppm = owed > 0n ? Number((held * 1_000_000n) / owed) : null;
      if (owed > held) b.short = owed - held;
    } catch (e) {
      b.error = (e as Error).message || String(e);
    }
    out.set(key, b);
  };
  const entries = Object.entries(cfg.assets).filter(([, a]) => a.custody.length > 0);
  for (let i = 0; i < entries.length; i += 3) await Promise.all(entries.slice(i, i + 3).map(([k, a]) => one(k, a)));
  return out;
}

/** Why a route's backing couldn't be read, if it couldn't (for the n/a tooltip). */
export function routeBackingError(route: string, by: Map<string, AssetBacking>): string | undefined {
  const [src, dst] = route.split("->");
  const failed = [src, dst].map((a) => by.get(a!)).find((x) => x && x.ppm === null);
  return failed ? `${failed.asset.split(":")[0]!.toUpperCase()}: ${failed.error ?? "no reading"}` : undefined;
}

/** A route's backing: the lowest of its bridged assets. NEAR-native assets need none. */
export function routeBacking(route: string, by: Map<string, AssetBacking>): number | null {
  const [src, dst] = route.split("->");
  const sides = [src, dst].map((a) => by.get(a!)).filter((x): x is AssetBacking => !!x);
  // A side that couldn't be read makes the route's backing unknown, never the other side's figure.
  if (!sides.length || sides.some((x) => x.ppm === null)) return null;
  return Math.min(...sides.map((x) => x.ppm!));
}

/** Each chain's latest block time, read from the same endpoints (for "Last block … ago"). */
export async function readHeads(cfg: ProofConfig): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const jobs: Promise<void>[] = Object.entries(cfg.chains).map(async ([chain, c]) => {
    try {
      out.set(chain, (await withFallbacks(chain, c, (r) => r.head())).headTimeMs);
    } catch {
      /* unknown stays unknown */
    }
  });
  jobs.push((async () => {
    try {
      out.set("near", (await new NearRpc(cfg.nearRpc, HTTP).head()).headTimeMs);
    } catch {
      /* unknown */
    }
  })());
  await Promise.all(jobs);
  return out;
}
