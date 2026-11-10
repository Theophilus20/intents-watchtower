# Demo and submission kit

## 2:40 demo script

Record the status page full screen (or `apps/status/dist/standalone.html` in any browser) plus one terminal.

| Time | Show | Say |
|---|---|---|
| 0:00 | Headlines of the 1 Oct 2026 exploit | "NEAR Intents has moved over $37 billion. On 1 October about $3.8 million left through a bridge bug, with nothing deposited behind it. Nobody outside the team could see it happen." |
| 0:12 | Status page at T−30. "Check a swap": $50K USDT on BNB Chain into USDC on NEAR says **Go ahead** | "This is Watchtower. Ask it the question you actually have: can I send this, right now?" |
| 0:28 | Press Play. T+0: three BSC routes go amber | "A simulation built on the public facts. The first $90K credit appears with no deposit behind it. Backing drops the same minute." |
| 0:42 | T+4: red. The swap panel flips to **Use another route**: safe size $0, ETH into USDC can take $120K | "Four minutes in, the unbacked credit is already leaving. The same swap is now refused, and Watchtower says what to do instead." |
| 1:00 | Tap the red route: checks, the sentence, 97.6% after red | "In this replay, 97.6% of the drain happened after Watchtower went red. No route that avoids BSC went red." |
| 1:15 | Type $250K on BTC into USDC: **Send it in parts** | "Every verdict carries a signed safe size: how much a route can carry, not only whether it's up. The contract enforces it with check_intent." |
| 1:30 | Claude Code with the Watchtower MCP server: "Before I swap $50K USDT on BSC into USDC on NEAR, check it with Watchtower" | "AI agents are sending money now. Any agent that speaks MCP asks before it sends, and only goes when the contract agrees." |
| 1:50 | Explain in French, then Spanish | "Plain language, in the reader's language. The words never decide; status comes from deterministic checks." |
| 2:02 | Toggle 'Feed watcher 3 a lying RPC' | "Don't trust us either. Three watchers sign every verdict. One can raise the alarm, never lower it, and a liar can't reach quorum." |
| 2:18 | Terminal: `npm run demo:whale`, then `npm run ci` | "It doesn't cry wolf: a whale's legitimate $1.95M withdrawal is amber, never red. 243 tests, including Rust verifying signatures made in TypeScript." |
| 2:35 | Wordmark | "Intents Watchtower. Don't trust the bridge. Watch it." |

Say "in this simulation" whenever you quote a number from a replay.

## One-liner

Intents Watchtower is an open, verifiable safety layer for NEAR Intents: it proves cross-chain balances are backed, catches credits with nothing behind them, and tells every person, contract and AI agent whether a swap is safe right now and how much the route can carry.

## "What did you build?" (under 2,000 characters)

> NEAR Intents has moved over $37 billion, but nobody outside the team can verify in real time that credited balances are backed or that a route can take a given swap. The 1 Oct 2026 exploit (~$3.8M withdrawn with nothing behind it) showed the risk lives at the bridges, and AI agents now send money without reading any dashboard.
>
> Intents Watchtower watches both sides of every bridge. A deterministic engine reconciles home-chain custody against credited supply, pairs every NEAR credit with a real deposit (the October pattern), flags attack-shaped flows with a two-signal rule, measures solver concentration, and propagates chain stalls, reorgs, advisories and depegs. Each verdict also carries a safe size: the most a route can carry, from hot-wallet payout liquidity and the depth solvers actually showed.
>
> Independent watchers sign verdicts with ed25519. watchtower.near, a Rust contract, accepts them from anyone: one signature raises the alarm, recovery needs a quorum, stale data fails closed. Apps call is_safe(route) or check_intent(route, amount). People get "Check a swap": go, send it in parts, use another route, or don't send. AI agents get the same answer through an MCP server, which only says go when the contract agrees.
>
> An exploit time machine replays incidents minute by minute. On a simulation of the October pattern routes went red 4 minutes after the first ghost credit, 97.6% of the simulated drain came after the alarm, and no unrelated route went red.
>
> 243 tests, including the Rust contract verifying signatures made by the TypeScript watchers.

## X post

> Built at #NEARHackathon: Intents Watchtower 🛰️
>
> The smoke alarm for @NEARProtocol Intents.
> ✅ Proof of backing across chains
> 👻 Catches credits with nothing behind them
> 📏 Signed safe size: how much, not only whether
> 🤖 An MCP check for every AI agent
> 🔁 Replays incidents minute by minute
>
> Don't trust the bridge. Watch it. 👇
> [demo video] [repo link]

## Checklist

- [ ] Repo public, README on top, CI green
- [ ] Contract deployed to testnet (`scripts/deploy-testnet.sh`), contract id in README
- [ ] Demo video recorded (≤ 3 min)
- [ ] X post with video, tagging @NEARProtocol and #NEARHackathon
- [ ] Form submitted with repo link, X link and your `.near` wallet before **14 Nov 2026, 23:59 UTC** (00:59 on 15 Nov in Lagos)
- [ ] Tracks: Open Innovation (+ AI Security & Defense, Agent Economy if allowed)
