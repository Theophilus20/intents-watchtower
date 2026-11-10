import type { AssetKey, RouteId } from "@watchtower/core";
import type { World } from "./world.ts";

export interface ScenarioEvent {
  atMin: number;
  label: string;
  apply: (w: World) => void;
}

export interface Scenario {
  id: string;
  title: string;
  /** One-line description shown in the time machine. */
  summary: string;
  /** Always true for built-in scenarios: they are models, not recordings. */
  simulated: boolean;
  /** What public facts the model is built on, and what is assumed. */
  basis: { facts: string[]; assumptions: string[]; sources: { title: string; url: string }[] };
  seed: string;
  startMs: number;
  durationMin: number;
  incidentAtMin: number;
  /** Routes the incident should hit. Everything else should stay green (precision check). */
  focusRoutes: RouteId[];
  /** Assets whose numbers the time machine charts. */
  focusAssets: AssetKey[];
  events: ScenarioEvent[];
  /** What a correct engine is expected to do; asserted in tests. */
  expect: { focusRed?: boolean; focusMaxStatus?: "amber" | "unknown"; noCollateralRed?: boolean; recoversByEnd?: boolean };
}

const T = Date.UTC(2026, 9, 1, 9, 0, 0); // 1 Oct 2026 09:00 UTC (illustrative clock, not the real incident time)
const ATTACKER = "a4c1e9d27b30f5e8c6d19a0b7f2e4c3d8b5a6e1f0c9d2b7a4e3f6c8d1b0a9e7f"; // NEAR implicit account

const BSC_ROUTES: RouteId[] = ["usdt:bsc->usdc:near", "bnb:bsc->eth:ethereum", "near:near->usdt:bsc", "usdt:bsc->btc:bitcoin"];

function round(atMin: number, legs: { asset: AssetKey; usd: number }[]): ScenarioEvent[] {
  return [
    {
      atMin,
      label: `Ghost credit: ${legs.map((l) => `$${(l.usd / 1000).toFixed(0)}K ${l.asset.split(":")[0]!.toUpperCase()}`).join(" + ")} appears on NEAR with no BSC deposit`,
      apply: (w) => {
        for (const l of legs) w.ghostCredit(l.asset, l.usd, ATTACKER);
      },
    },
    {
      atMin: atMin + 1,
      label: "Attacker withdraws to BSC through the hot wallet",
      apply: (w) => {
        for (const l of legs) w.withdraw(l.asset, w.usdToUnits(l.asset, l.usd * 0.985), ATTACKER, { payDelayMs: 60_000, attack: true });
      },
    },
  ];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "oct-2026-ghost-credit",
    title: "1 Oct 2026: ghost credits via a bridge-integration bug",
    summary: "Balances appear on NEAR with nothing deposited behind them, then leave through the BSC hot wallet in waves.",
    simulated: true,
    basis: {
      facts: [
        "On 1 Oct 2026 NEAR Intents reported an exploit of about $3.8M.",
        "The team attributed it to a bug in how the Omni deposit/withdrawal infrastructure interacted with the Intents contract.",
        "The attacker made several withdrawals from the platform's hot wallet on BSC.",
        "Deposits and withdrawals on BSC and several other networks were paused while fixes were deployed.",
      ],
      assumptions: [
        "Exact on-chain timing, sizes and number of rounds are not public; this replay uses illustrative waves that sum to about $3.8M.",
        "The engine clock in this replay is illustrative (09:00 UTC), not the real incident time.",
        "It shows when Watchtower's checks would fire on this pattern. It does not claim when the real exploit would have been caught.",
      ],
      sources: [
        { title: "ForkLog: NEAR Intents reports $3.8M theft", url: "https://forklog.com/en/near-intents-reports-3-8-million-theft/" },
        { title: "KuCoin News: NEAR Intents confirms security breach", url: "https://www.kucoin.com/news/flash/near-intents-confirms-security-breach-over-3-8m-stolen" },
      ],
    },
    seed: "oct-2026",
    startMs: T,
    durationMin: 120,
    incidentAtMin: 30,
    focusRoutes: BSC_ROUTES,
    focusAssets: ["usdt:bsc", "bnb:bsc"],
    events: [
      { atMin: 10, label: "A new NEAR account is created", apply: (w) => w.createAccount(ATTACKER) },
      ...round(30, [{ asset: "usdt:bsc", usd: 90_000 }]),
      ...round(36, [{ asset: "usdt:bsc", usd: 480_000 }, { asset: "bnb:bsc", usd: 210_000 }]),
      ...round(43, [{ asset: "usdt:bsc", usd: 640_000 }]),
      ...round(50, [{ asset: "usdt:bsc", usd: 720_000 }, { asset: "bnb:bsc", usd: 260_000 }]),
      ...round(58, [{ asset: "usdt:bsc", usd: 820_000 }]),
      ...round(66, [{ asset: "usdt:bsc", usd: 560_000 }]),
    ],
    expect: { focusRed: true, noCollateralRed: true },
  },
  {
    id: "apr-2026-litecoin-zero-day",
    title: "April 2026: a zero-day on a connected chain (Litecoin)",
    summary: "Nothing breaks on NEAR, but a dependency does. Every route touching Litecoin goes red; nothing else moves.",
    simulated: true,
    basis: {
      facts: [
        "In April 2026 a zero-day bug in Litecoin, a chain connected to NEAR Intents, created roughly $600K of exposure, which the team covered.",
      ],
      assumptions: [
        "Modelled as a red security advisory plus a 4-block reorganisation. The real bug's mechanics are not reproduced.",
      ],
      sources: [{ title: "Levex: NEAR Intents risks and the Litecoin incident", url: "https://levex.com/en/blog/near-intents" }],
    },
    seed: "apr-2026",
    startMs: Date.UTC(2026, 3, 14, 13, 0, 0),
    durationMin: 150,
    incidentAtMin: 30,
    focusRoutes: ["ltc:litecoin->usdc:near", "ltc:litecoin->btc:bitcoin"],
    focusAssets: ["ltc:litecoin"],
    events: [
      {
        atMin: 30,
        label: "Security advisory: Litecoin client zero-day disclosed",
        apply: (w) => w.advisory({ id: "ltc-zero-day", chain: "litecoin", severity: "red", title: "Litecoin client zero-day (simulated)", fromMs: w.nowMs, untilMs: w.nowMs + 70 * 60_000 }),
      },
      { atMin: 38, label: "Litecoin reorganises 4 blocks", apply: (w) => w.reorg("litecoin", 4) },
      { atMin: 60, label: "Litecoin chain stable again", apply: (w) => w.reorg("litecoin", 0) },
      { atMin: 100, label: "Advisory resolved; patched clients deployed", apply: () => {} },
    ],
    expect: { focusRed: true, noCollateralRed: true, recoversByEnd: true },
  },
  {
    id: "whale-day",
    title: "False-alarm test: a whale's legitimate $1.95M withdrawal",
    summary: "A long-standing account withdraws a lot of ETH it really owns. One signal fires; the route goes amber, never red.",
    simulated: true,
    basis: {
      facts: ["Large legitimate withdrawals happen. A safety signal that cries wolf gets ignored or switched off."],
      assumptions: ["Three $650K ETH withdrawals by an account active for months, fully backed."],
      sources: [],
    },
    seed: "whale-day",
    startMs: Date.UTC(2026, 9, 20, 15, 0, 0),
    durationMin: 120,
    incidentAtMin: 30,
    focusRoutes: ["eth:ethereum->usdc:near", "bnb:bsc->eth:ethereum", "eth:ethereum->sol:solana"],
    focusAssets: ["eth:ethereum"],
    events: [30, 34, 38].map((m) => ({
      atMin: m,
      label: "Long-standing account withdraws $650K of ETH",
      apply: (w: World) => {
        w.withdraw("eth:ethereum", w.usdToUnits("eth:ethereum", 650_000), w.users[0]!);
      },
    })),
    expect: { focusMaxStatus: "amber", noCollateralRed: true, recoversByEnd: true },
  },
  {
    id: "stale-custody-feed",
    title: "Fail-closed: the Bitcoin custody feed goes silent",
    summary: "We stop seeing Bitcoin custody balances. Silence is not safety: BTC routes go unknown and is_safe returns false.",
    simulated: true,
    basis: { facts: ["RPC providers fail. A monitor that shows green when it is blind is worse than no monitor."], assumptions: ["The custody feed stops for 25 minutes."], sources: [] },
    seed: "stale-feed",
    startMs: Date.UTC(2026, 10, 2, 7, 0, 0),
    durationMin: 90,
    incidentAtMin: 20,
    focusRoutes: ["btc:bitcoin->usdc:near", "usdc:near->btc:bitcoin", "usdt:bsc->btc:bitcoin", "ltc:litecoin->btc:bitcoin"],
    focusAssets: ["btc:bitcoin"],
    events: [
      { atMin: 20, label: "Bitcoin custody feed stops responding", apply: (w) => w.freeze("custody:btc:bitcoin", w.nowMs + 25 * 60_000) },
      { atMin: 45, label: "Custody feed restored", apply: () => {} },
    ],
    expect: { focusMaxStatus: "unknown", noCollateralRed: true, recoversByEnd: true },
  },
  {
    id: "usdt-bsc-depeg",
    title: "Stablecoin depeg: USDT on BSC trades at $0.962",
    summary: "The bridge is fine, the asset isn't. Routes holding BSC USDT go red until the peg returns.",
    simulated: true,
    basis: { facts: ["Stablecoins have depegged on individual chains during bridge and market stress."], assumptions: ["A 3.8% depeg lasting 30 minutes."], sources: [] },
    seed: "depeg",
    startMs: Date.UTC(2026, 10, 3, 18, 0, 0),
    durationMin: 100,
    incidentAtMin: 25,
    focusRoutes: BSC_ROUTES.filter((r) => r.includes("usdt:bsc")),
    focusAssets: ["usdt:bsc"],
    events: [
      { atMin: 25, label: "USDT on BSC drops to $0.962", apply: (w) => w.depeg("usdt:bsc", 0.962) },
      { atMin: 55, label: "Peg restored at $0.999", apply: (w) => w.depeg("usdt:bsc", 0.999) },
    ],
    expect: { focusRed: true, noCollateralRed: true, recoversByEnd: true },
  },
];

export function getScenario(id: string): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown scenario "${id}". Available: ${SCENARIOS.map((x) => x.id).join(", ")}`);
  return s;
}
