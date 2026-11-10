# Watchtower for AI agents (MCP)

AI agents are starting to move real money through NEAR Intents. This server gives any agent that speaks the
Model Context Protocol (Claude, Codex, Cursor, NEAR AI agents) one question to ask before it sends:

> "I want to move $50,000 of USDT on BNB Chain into USDC on NEAR. Should I?"

and one of four answers, built from the verdict independent watchers signed on-chain:

| Decision | Meaning | What the agent should do |
| --- | --- | --- |
| **go** | Route is healthy and the amount fits its safe size | Send |
| **reduce** | Route is healthy but the amount is bigger than it can safely carry | Split into the suggested number of swaps |
| **reroute** | Route is paused or too small, a healthy route delivers the same token | Use the suggested route |
| **wait** | Nothing healthy can take this amount right now | Don't send, tell the user why |

"go" is only returned when the contract's own `check_intent(route, amount)` also allows it, so the agent and an
on-chain guard can never disagree.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `check_swap` | `from`, `to`, `amount_usd`, optional `allow_amber` | decision, plain-language reason, safe size, alternative or split, the on-chain `check_intent` answer |
| `check_route` | `from`, `to` | what `is_safe()` returns, plus status, score, safe size, reasons, verdict age, report hash |
| `list_routes` | optional `status` | every route, problems first, with its safe size |
| `explain_route` | `from`, `to`, optional `lang` (`en`, `fr`, `es`) | one paragraph a non-expert can read |

Tokens can be written as keys (`usdt:bsc`, `btc:bitcoin`) or in plain words (`USDT on BSC`, `btc`, `NEAR`).
If a symbol exists on more than one chain (USDC), the tool says which chains exist instead of guessing.

All tools are read-only. Every answer starts with its source line, so a replay is never mistaken for the live network.

## Run it

```powershell
npm run build:mcp                  # once: writes packages/mcp/dist/watchtower-mcp.mjs (plain Node, no tsx needed)
npm run mcp                        # or run from source: replay of the October incident, 30 min in
```

Options (also as environment variables `WATCHTOWER_REPLAY`, `WATCHTOWER_AT`, `WATCHTOWER_LIVE`, `WATCHTOWER_CONTRACT`, `WATCHTOWER_RPC`):

```
--replay <scenario> --at <minutes>    a recorded incident at a chosen moment (default oct-2026-ghost-credit, 30)
--live mainnet|testnet                the deployed contract
--contract <account> --rpc <url>      a different deployment or RPC
```

Until the contract is deployed, use the replay: it runs the real engine, signs verdicts with demo watchers and
answers through the same SDK calls an integration makes.

## Connect a client

The examples use the Windows path `C:\Users\USER\intents-watchtower`. Change it to wherever the project lives.

**Claude Code**

```powershell
claude mcp add watchtower -- node C:\Users\USER\intents-watchtower\packages\mcp\dist\watchtower-mcp.mjs
```

**Claude Desktop**: edit `%APPDATA%\Claude\claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`), then restart the app.

```json
{
  "mcpServers": {
    "watchtower": {
      "command": "node",
      "args": ["C:\\Users\\USER\\intents-watchtower\\packages\\mcp\\dist\\watchtower-mcp.mjs"]
    }
  }
}
```

**Codex**: `~/.codex/config.toml`

```toml
[mcp_servers.watchtower]
command = "node"
args = ["C:\\Users\\USER\\intents-watchtower\\packages\\mcp\\dist\\watchtower-mcp.mjs"]
```

**Cursor**: `.cursor/mcp.json` takes the same `mcpServers` block as Claude Desktop.

Then ask: *"Before I swap $50,000 USDT on BSC into USDC on NEAR, check it with Watchtower."*

## Example answers (replay, 30 minutes into the October incident)

```
REROUTE. Don't send via USDT on BNB Chain → USDC on NEAR now: Only 92.53% of credited funds are backed,
and $1.93M were credited on NEAR with no matching deposit. Avoid this route until it turns green.
If you can fund from ETH on Ethereum instead, use that: ETH on Ethereum → USDC on NEAR is healthy
(score 100/100) and can take up to $120,000.

GO. $20,000 via BTC on Bitcoin → USDC on NEAR is within the safe size of $86,000.

REDUCE. BTC on Bitcoin → USDC on NEAR is healthy, but $250,000 is more than its safe size of $86,000.
Split it into 3 swaps of about $83,333 each, a few minutes apart, and check again before each one.
```

## Protocol

Dependency-free stdio transport: newline-delimited JSON-RPC 2.0, protocol versions 2025-06-18, 2025-03-26 and
2024-11-05, with `initialize`, `ping`, `tools/list` and `tools/call`. Tool errors (an unreadable token, an
unreachable RPC) come back as `isError` results with a sentence the agent can relay, and always mean "don't send".
