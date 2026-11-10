# @intents-watchtower/sdk

One call before every swap: is this NEAR Intents route safe right now?

```ts
import { Watchtower } from "@intents-watchtower/sdk";

const wt = new Watchtower({ network: "mainnet" });          // or { network: "testnet" }, { contractId, rpcUrl }
if (!(await wt.isSafe("btc:bitcoin->usdc:near"))) return;  // fail-closed

const c = await wt.check("usdt:bsc->usdc:near");           // { safe, verdict, status, score, reasons, age_sec, report_hash }
const best = await wt.safestRoute(["eth:ethereum->usdc:near", "usdc:ethereum->usdc:near"]);

// How much: allowed only if the route is safe AND the amount fits the safe size the watchers signed.
const i = await wt.checkIntent("btc:bitcoin->usdc:near", 50_000);  // { allowed, verdict: "ok" | "over_capacity" | ..., capacity_usd }
```

## Guard an agent

```ts
import { withWatchtower, RouteUnsafeError } from "@intents-watchtower/sdk";

const safeAgent = withWatchtower(agent, {
  client: wt,
  methods: ["swap"],                                   // default: swap, executeSwap, trade, bridge, withdraw
  routeOf: (_m, [req]) => `${req.from}->${req.to}`,    // default understands {route}, {from,to}, {originAsset,destinationAsset}
  alternatives: (route) => candidateRoutes(route),     // optional
  withRoute: (args, route) => [{ ...args[0], route }], // required for alternatives
  onDecision: (d) => log(d),
});
```

Unsafe and no safe alternative → `RouteUnsafeError` with `.check` explaining why.

## Badge

```html
<script type="module" src="https://unpkg.com/@intents-watchtower/sdk/dist/badge.js"></script>
<watchtower-badge route="eth:ethereum->usdc:near"></watchtower-badge>
```

## Options

| Option | Default | |
|---|---|---|
| `network` | `"mainnet"` | `watchtower.near` on mainnet, `watchtower.testnet` on testnet |
| `contractId`, `rpcUrl` | network defaults | override for your own deployment |
| `cacheMs` | `5000` | identical calls are shared for this long |
| `timeoutMs` | `4000` | per RPC request |
| `failOpen` | `false` | what `isSafe` returns when the oracle can't be reached |
| `source` | NEAR RPC | any `{ view(method, args) }`, e.g. a local contract model |

Zero dependencies. Node 18+, browsers, Deno, Bun, edge runtimes.
