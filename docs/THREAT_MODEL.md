# Threat model

What Watchtower defends against, what it doesn't, and how each part fails.

## What it is (and isn't)

Watchtower is an **alarm and a circuit-breaker signal**. It cannot stop an attacker who calls the bridge directly. It protects everyone who checks before acting (users, wallets, agents, market makers), gives operators an independent early signal to pause, and gives the public a verifiable record of what was known when.

## Assets

1. The truth of `is_safe(route)` on-chain.
2. Watcher signing keys.
3. The integrity of the published reports.
4. Availability of the signal.

## Adversaries and mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| **One watcher is compromised and tries to keep a broken route green** | Recovery to green, and keeping green fresh, need `quorum` signatures. A lone green vote is stored as that watcher's latest vote and never applied on its own. A green that is not refreshed by quorum goes stale and `is_safe` returns false after `max_age_sec`. | A compromised *quorum* can lie. Mitigated by watcher diversity (operators, hosting, RPC providers) and by staking/slashing on the roadmap. |
| **One watcher is compromised and turns safe routes red** (griefing) | Allowed by design: raising the alarm must be cheap. Every watcher's latest vote and the `watcher_disagreement` events make the outlier visible; the owner can remove the watcher. | Temporary denial of service on affected routes. Fail-closed is the right default for money. |
| **A watcher signs a red that hides the real reason** (softening red into unknown) | Red → unknown is treated as de-escalation and needs quorum. | None beyond quorum compromise. |
| **Replay of an old green signature** | Signatures bind contract, route, epoch and full verdict. Epochs must be within 15 minutes of block time, not in the future, and not older than the stored epoch. | None known. |
| **Cross-contract or cross-network replay** (testnet signature on mainnet) | The contract account id is inside the signed message. | None known. |
| **Relayer drops or delays attestations** | Anyone can relay; watchers can submit themselves. Escalations bypass batching. Stale routes fail closed. | Delay shows as staleness, never as false safety. |
| **Lying RPC / data source for one watcher** | Its hash differs from honest watchers, so it cannot reach quorum alone; disagreement is published. The `tamper` test in `packages/watcher/test` exercises this. | If *every* watcher uses the same lying provider, they agree on a lie. Operators must use independent providers; the runbook requires it. |
| **Attacker stays under thresholds** (small ghost credits, slow drain) | Layers are independent: every unmatched credit past its window is red regardless of size; backing catches the cumulative hole; drop-fast catches the trend. | A drain smaller than the 0.5% backing tolerance *and* matched to fake deposits would need the attacker to also fake home-chain deposits, which is a different and harder attack. |
| **Attacker forges a deposit to cover a ghost credit** | Deposits are read from home-chain state at finalized/confirmed heights by each watcher independently. | A deep reorg of the home chain; covered by the reorg signal and chain-specific windows. |
| **Guardian key compromise** | Guardians can only pause or force routes *less* safe; `set_override` rejects green; unpause and clearing overrides are owner-only. | Denial of service until the owner acts. |
| **Owner key compromise** | Owner can change the watcher set and quorum. | Real risk in the MVP. Move ownership to a DAO or multisig before mainnet (runbook step). |
| **Storage exhaustion** | Only registered watchers' signatures create routes; routes capped at 1,024; one stored vote per watcher per route (32 at most); receipts pay their own storage. | None material. |
| **AI explainer hallucinates** | Status never comes from the model. Output is rejected if it has the wrong emoji, another status, > 300 chars, or any number not in the facts; the template is used instead. | Wording quality only. |

## Failure modes and what callers see

| Failure | `is_safe` | `check_route().verdict` |
|---|---|---|
| Watchers offline | false after `max_age_sec` | `stale` |
| Route never reported | false | `no_data` |
| Data source down | false | `status` (unknown) |
| Contract paused | false | `paused` |
| SDK cannot reach RPC | false (unless `failOpen`) | `error` |
