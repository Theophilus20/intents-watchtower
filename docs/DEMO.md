# Demo and submission kit

## 2:55 demo script

Record https://www.intentswatchtower.xyz full screen, plus one terminal. The page opens on the live contract; pick a replay from the selector at the top right for the incident scenes.

| Time | Show | Say |
|---|---|---|
| 0:00 | Headlines of the 1 Oct 2026 exploit | "NEAR Intents has moved over $37 billion. On 1 October about $3.8 million left through a bridge bug, with nothing deposited behind it. Nobody outside the team could see it happen." |
| 0:12 | The live page: route table, "Watchers who signed: 3" | "This is Intents Watchtower, live. Three watchers read real mainnet data every minute, the token supply on NEAR and the bridge treasuries on five chains, and sign a verdict per route into a NEAR contract." |
| 0:28 | Hover a green row's backing (for example SOL, 102%), then the BTC row: 97.47%, Partly verified | "Five assets are fully backed against the official treasury list. For Bitcoin, the published treasury holds 97.47% of the supply. Watchtower can't verify the rest from public data, so it says exactly that, and turns red if the gap grows." |
| 0:45 | Switch to the October replay. "Check a swap": $50K USDT on BNB Chain into USDC on NEAR says **Go ahead** | "Now the October pattern, as a simulation. Ask the question you actually have: can I send this, right now?" |
| 0:58 | Press Play. T+0 amber, T+4 red. The swap panel flips to **Use another route** | "The first credit appears with no deposit behind it. Four minutes in it is already leaving: the route goes red, the same swap is refused, and Watchtower says what to do instead." |
| 1:18 | Tap the red route: checks, the sentence, 97.6% after red | "In this simulation, 97.6% of the drain happened after Watchtower went red. No route that avoids BNB Chain went red." |
| 1:32 | Type $250K on BTC into USDC: **Send it in parts** | "Every verdict carries a signed safe size: how much a route can carry, not only whether it's up. The contract enforces it with check_intent." |
| 1:46 | Claude Code with the Watchtower MCP server: "Before I swap $50K USDT on BSC into USDC on NEAR, check it with Watchtower" | "AI agents are sending money now. Any agent that speaks MCP asks before it sends, and only goes when the contract agrees." |
| 2:06 | Settings: switch the language to French, then back | "Plain language, in eleven languages. The words never decide; status comes from deterministic checks." |
| 2:16 | Toggle 'Feed watcher 3 a lying RPC' | "Don't trust us either. One watcher can raise the alarm, never lower it, and a liar can't reach quorum." |
| 2:32 | Terminal: `npm run demo:whale`, then `npm test` | "It doesn't cry wolf: a whale's legitimate $1.95M withdrawal is amber, never red. 243 tests, including Rust verifying signatures made in TypeScript." |
| 2:48 | Wordmark and intentswatchtower.xyz | "Intents Watchtower. Don't trust the bridge. Watch it." |

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
> It is live: three watchers read real mainnet data and sign verdicts into a NEAR testnet contract, and the status page re-checks every treasury in the visitor's browser. Checked against the official treasury list, five assets are fully backed; for Bitcoin and Litecoin the published treasuries hold about 97.5% and 98.6% of supply, so Watchtower marks them partly verified and alarms if the gap grows.
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
> [demo video] https://www.intentswatchtower.xyz [repo link]

## Checklist

- [ ] Repo public, README on top
- [x] Status page live at https://www.intentswatchtower.xyz, watchers running in the cloud
- [ ] Contract deployed to testnet (`scripts/deploy-testnet.sh`), contract id in README
- [ ] Demo video recorded (≤ 3 min)
- [ ] X post with video, tagging @NEARProtocol and #NEARHackathon
- [ ] Form submitted with repo link, X link and your `.near` wallet before **14 Nov 2026, 23:59 UTC** (00:59 on 15 Nov in Lagos)
- [ ] Tracks: Open Innovation (+ AI Security & Defense, Agent Economy if allowed)
