# More than a watcher

Watchtower started as an alarm: tell people when a NEAR Intents route is not backed. This document explains what
it became, why each piece exists, and what is built versus planned. Every outside figure has a source; every
Watchtower figure comes from a command you can run.

## The problem, in numbers

**The money is real and growing.** NEAR Intents passed $37 billion in all-time volume and more than 37 million
swaps by 3 November 2026, up from $34 billion on 13 October ([TokenPost](https://www.tokenpost.com/news/technology/47424)).

**Cross-chain credit is where it breaks.** On 18 April 2026 an attacker forged one bridge message and minted
116,500 rsETH with nothing behind it, about $292 million. KelpDAO's bridge needed one verifier's signature; the
minted tokens were posted as collateral on Aave within minutes, and the manual pause came 46 minutes after the
first mint, too late to unwind the loans ([DeFi Prime](https://defiprime.com/kelpdao-rseth-exploit),
[Blockaid](https://blockaid.io/blog/how-a-single-layerzero-dvn-compromise-drained-292m-from-kelpdao)).
PeckShield counted $328.6 million drained in eight bridge exploits by mid-May 2026
([Bitcoin.com](https://news.bitcoin.com/crypto-bridge-exploits-328-million-may-2026-peckshield/); the article's
own per-incident figures don't add up to its total, so treat it as an order of magnitude).

**Humans are too slow.** The average DeFi incident response takes 37 minutes; the average exploit finishes in
under 60 seconds ([DEV Community, "DeFi circuit breakers in 2026"](https://dev.to/ohmygod/defi-circuit-breakers-in-2026-from-erc-7265-to-aave-shield-five-patterns-that-actually-work-4650)).

**Insurance barely exists, and it needs objective triggers.** On-chain cover reaches roughly 0.5% of DeFi TVL.
Parametric cover pays automatically but "only covers events that are observable, measurable, and binary"; minting
flaws gave no on-chain warning a trigger could use, and about 80% of Q1 2026 losses were events parametric models
couldn't trigger on ([BlockEden](https://blockeden.xyz/blog/2026/05/03/defi-insurance-450m-q1-hacks-coverage-gap/)).

**Intents have their own failure mode: running out of liquidity.** Solvers front their own capital, so an attacker
can submit timed large intents to drain it. Across 3.5 million intents ($9.24B), deBridge's top solver handled 94%
of fills and the attack was profitable 80.5% of the time in one configuration
([arXiv 2602.17805](https://arxiv.org/html/2602.17805v1)).

**And the senders are increasingly software.** NEAR's AI Agent Market lets agents hire each other with escrowed
payment, built on NEAR Intents ([The Cryptonomist](https://en.cryptonomist.ch/2026/02/05/near-ai-agents-marketplace)).
An agent can't read a security dashboard.

## What already exists, and the gap

| Tool | What it does well | What it leaves open |
| --- | --- | --- |
| **SHIELD**, NEAR Intents' proactive security layer ([docs](https://docs.near-intents.org/security-compliance/proactive-intents-security)) | Quote-time controls on integrated 1Click requests; Normal, Paranoid and Under-attack modes; a rule-based, explainable anomaly engine; a read-only status feed | Producers are authorised one by one, partners see their own action history, and the docs don't describe decisions as publicly verifiable. A contract or wallet outside the integration can't read a signed answer. |
| **Chainlink Secure Mint** ([docs](https://docs.chain.link/ace/reference/policy-library/secure-mint-policy)) | Blocks a token's own mint when reserves don't cover it | Lives inside the issuer's mint function. It doesn't see a routing layer crediting balances on NEAR against custody on another chain, and says nothing about a route. |
| **Circuit breakers** (ERC-7265, pause guardians) | Throttle or pause a protocol's own outflows | Internal to one protocol and hard to calibrate. They don't help an outside app choose a route. |
| **Commercial monitoring** | Fast alerts for paying customers | Closed alerts, not a signed fact a contract can enforce. |

The gap: nobody publishes an **open, signed, size-aware** answer to "is this route backed right now, and how
much can it carry?" that a wallet, a contract, an insurer and an AI agent can all read and check for themselves.

## What Watchtower adds

**1. Proof of backing and ghost-credit detection.** For every bridged asset, credited supply on NEAR against
custody on the home chain, plus every credit matched to a deposit. Credits with no deposit behind them are the
KelpDAO and Resolv class of failure. Because it is observable, measurable and binary, it is also a valid trigger
for parametric cover. *Built* (`packages/engine`).

**2. Safe size.** Each signed verdict now carries `capacity_usd`: the most that can move through a route right
now. It is the tighter of half the hot-wallet liquidity that pays the destination and the depth solvers actually
demonstrated (their three largest fills in 24 hours), halved on caution, zero when unsafe or unverified. This is
the direct answer to liquidity exhaustion: swaps above it lean on liquidity nobody has shown. Watchers sign it,
so a relayer can't inflate it. *Built* (`packages/engine/src/capacity.ts`, attestation v2, contract and tests).

**3. A size-aware on-chain check.** `check_intent(route_id, amount_usd)` returns `allowed` only when the route is
safe **and** the amount fits the signed safe size; otherwise `over_capacity`, `status`, `stale` or `no_data`.
Fail-closed like `is_safe`. *Built* (contract, TypeScript mirror, SDK `checkIntent`).

**4. One decision instead of a dashboard.** Pre-flight turns route state into **go**, **send it in parts**, **use
another route** (preferring one that keeps the token you hold) or **don't send now**, with the reason in plain
language. The status app's "Check a swap" panel and the agent tools use the same function. *Built*.

**5. A safety check AI agents can call.** An MCP server with `check_swap`, `check_route`, `list_routes` and
`explain_route`. Claude, Codex, Cursor or any MCP client asks before it moves money and gets the same answer the
contract would give. Dependency-free, read-only, labelled when the data is a replay. *Built* (`packages/mcp`).

**6. Verifiable by anyone.** The engine is deterministic (integer money, canonical JSON, a hash chain over
inputs); every verdict has a report hash; watchers sign with ed25519; the contract needs a quorum to turn a route
green and one signature to turn it red. Anyone with the inputs can recompute the hash. *Built*.

**7. Evidence instead of claims.** The replays run the production engine against modelled incidents and measure
the result. In the October ghost-credit replay the first alert fires at the first ghost credit (T+0), the route is
red at T+4 minutes, and 97.6% of the attacker's $3.72M in withdrawals happened after Watchtower was red, so a
contract calling `is_safe` would have refused them. Unrelated routes spend zero minutes red in all five scenarios.
Run `npm run demo:all`. *Built, simulated data.*

## Complementary to SHIELD

Watchtower doesn't replace SHIELD's quote-time controls; it can feed them. A Watchtower red verdict is a natural
SHIELD incident, and SHIELD's modes map onto Watchtower statuses (amber to Paranoid, red to Under attack). Being a
SHIELD producer needs NEAR Intents to grant access, so this is a proposal, not a claim.

## Roadmap

| When | What |
| --- | --- |
| Built | Five checks, safe size, signed verdicts, contract with quorum and `check_intent`, SDK, MCP server, status app with swap planner, exploit replays, three explanation languages |
| Next | Deploy to testnet; run three watchers by different operators; publish full reports so anyone can recompute the hashes; NEAR AI explanations behind the existing number-checking guard |
| Later | Watchers inside TEEs with remote attestation, so not even the operator can change the code that signs; parametric cover that settles on signed verdicts (for example "red with GHOST_CREDIT for 30 minutes"); per-solver liquidity-exhaustion alerts; SHIELD producer integration; watcher staking and slashing |

## Who pays for it

These are hypotheses to test, not revenue. Reading the contract is free, so wallets and apps adopt at no cost.
Value flows from the parties who carry the risk: insurers and cover protocols need objective triggers, solvers
want early warning before their inventory is drained, and the ecosystem has an interest in a public good that
makes $37 billion of flow safer.

## Check every claim in ten minutes

```
npm install
npm test                 # TypeScript suites, including safe size, MCP and the status page
npm run test:contract    # the Rust contract, including TypeScript-signed vectors (needs Rust)
npm run demo:all         # the five replays and their measured outcomes
npm run mcp              # the agent server (try it from Claude Code or Codex, see packages/mcp/README.md)
npm run app              # builds the status app into apps/status/dist/
```
