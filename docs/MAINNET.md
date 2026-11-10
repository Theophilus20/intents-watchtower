# Going live: testnet first, then mainnet

**Short version:** the contract is ready to deploy. The live data isn't proven yet. A mainnet oracle that apps
and AI agents rely on has to be right on day one, so the safe order is:

1. check the real data sources from your computer
2. deploy to testnet
3. run three watchers that read **real mainnet data** and publish to the **testnet** contract (shadow mode)
4. after a week of verdicts that match reality, deploy to mainnet

Shadow mode is real-life operation without the risk: the verdicts describe the real NEAR Intents network, but
nobody's money depends on them yet. It is also the strongest thing to show hackathon judges.

## Where things stand

| Piece | State |
| --- | --- |
| Contract logic | Ready: 35 Rust tests, including signatures made by the TypeScript watchers |
| Contract build (wasm) | Built on your computer by `npm run deploy` (this workspace has no NEAR toolchain) |
| Live data collectors | The reading side works against mainnet (above); a full watcher round with custody data is the next thing to prove |
| Live data | **Confirmed on a real machine:** `npm run doctor` reached NEAR mainnet, the block indexer, intents.near, the 1Click price list, four bridge token supplies and all five home chains |
| Custody addresses | **Not configured.** Without them backing can't be proven and bridged routes read "unverified" (which is safe, but not useful) |
| Watchers | `npm run deploy` creates three keys. For real independence they should run on three machines with different RPC providers |
| Contract owner | Your account. Before others rely on it, move ownership to a multisig or DAO |
| Security review | None yet. Treat it as hackathon code until it has been audited |

## What it costs

The contract never holds anyone's money, but running it on mainnet spends yours:

- **Deploying:** about 5 NEAR moves into the contract account. Most of it is locked for storage (NEAR charges
  1 NEAR per 100 KB) and comes back if you ever delete the account.
- **Running:** each watcher sends one transaction per round in which something is due, paid by the relayer
  account. Changes go out at once; unchanged verdicts are re-confirmed so the contract never goes stale (every
  4 minutes on testnet; on mainnet `npm run deploy` lets verdicts stay valid 15 minutes and watchers re-confirm
  every 10, set by `WATCHTOWER_REFRESH_MINUTES`). Routes that read "unverified" are not re-sent while unchanged,
  since a stale unverified verdict means the same thing. That is at most 360 transactions per watcher per day on
  testnet and 144 on mainnet, plus one per change. Measure the real cost instead of guessing: set
  `RELAYER_ACCOUNT_ID`, run `npm run doctor` before starting the watchers and again an hour later, and compare the
  Relayer line.
- **Testnet is free.** Run the whole flow there once first: if a step breaks on your machine, it costs nothing.

At least two watchers must be running for routes to stay green (one can raise the alarm, but recovery and
"still safe" need two signatures). If they stop, routes turn unverified after 15 minutes, which is the safe answer.

## Step 1: check the live data (read-only)

```powershell
npm run doctor
```

It reads NEAR mainnet, the block indexer, the 1Click price list, the bridge token supplies and every home
chain, then checks your custody configuration and says which routes could go green on mainnet (a route needs custody
for every bridged asset on it; the others honestly read unverified). Nothing is signed or sent. Every line is ✓, ! or ✗ with what to do.
If everything fails at once, it's your internet connection or a firewall, not the services.

## Step 2: deploy to testnet

You need a testnet account with some test NEAR (create one in any NEAR wallet on testnet and use its faucet),
plus two tools. On Windows, in PowerShell:

```powershell
irm https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.ps1 | iex
irm https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.ps1 | iex
near account import-account using-web-wallet network-config testnet
```

Rust comes from [rustup.rs](https://rustup.rs) (on Windows, also the Visual Studio C++ Build Tools). Any Rust version
will do as your default: the contract pins the one it is built with (`contracts/watchtower/rust-toolchain.toml`,
Rust 1.97.0, because near-sdk 5.30 needs 1.95 or newer) and `npm run deploy` installs it alongside yours. Then:

```powershell
npm run deploy
```

It asks for the network (press Enter for testnet), your account and the contract name (default
`watchtower.<your account>`), then builds, creates the account, deploys, registers three watchers and sets the
quorum to 2 of 3. Every command is printed before it runs. Watcher keys land in `data\watcher-1.json` to `-3.json`:
keep them secret and never commit them.

## Step 3: custody addresses

Backing can only be proven once Watchtower knows where each bridge keeps its coins. The finder reads each bridge
token's recent history (and anything the watchers recorded), so it works straight away:

```powershell
npm run custody          # traces those transactions to the bridges' wallets; read-only
npm run custody:apply    # writes hot wallets, and custody where the wallets hold the whole supply
npm run custody -- --apply --only eth:ethereum,usdc:ethereum   # apply only assets you have reviewed
```

Restart the watchers afterwards. Bridges that give every user their own deposit address (the PoA bridge does)
can't have their deposits matched to credits, so the ghost-credit check reports `GHOST_UNCHECKED` for them
instead of raising false alarms; the backing check still catches unbacked minting. Details and the manual method are in
[RUNBOOK.md](RUNBOOK.md#finding-custody-addresses). `npm run doctor` shows the Custody lines turning ✓.

## Step 4: run the watchers in shadow mode

Each watcher reads mainnet (the `live` section of the config) and publishes to the contract in `contractId`
(your testnet contract). Watcher accounts don't need to exist on-chain: the contract checks their signatures, and
one account of yours, the relayer, pays the gas. Save it once:

```powershell
near account export-account you.testnet using-private-key network-config testnet   # copy the ed25519:... key
npm run relayer                                                                      # paste the account and key
npm run watch:dry                                                                    # one round as watcher 1, sends nothing
```

Then start one watcher per PowerShell window, from the project folder:

```powershell
npm run watch:1     # window 1
npm run watch:2     # window 2
npm run watch:3     # window 3
```

Watchers on the same computer share NEAR downloads (`data\near-cache`), and each block is fetched as a small
header plus only the shards where intents.near and the bridge tokens live. Every round prints what it downloaded,
for example `downloaded 4.2 MB this round (96 NEAR blocks, shards 2, 5 only)`; check that line if you are on a
metered connection.

Each checks every minute, sends changes at once in one transaction per round, and re-confirms unchanged verdicts
every 4 minutes (10 on mainnet). Each line ends with the round in words, for example
`0 green, 0 amber, 0 red, 12 unverified. Main reasons: CUSTODY_DATA_STALE (12)`. Leave the windows open; closing one
stops that watcher.

Optional: `$env:FASTNEAR_API_KEY` (from dashboard.fastnear.com) if the download line keeps saying
`stopped reading: rate limited`; it is sent only to the NEAR RPC and neardata. `$env:NEAR_AI_API_KEY` for AI-written alerts, `$env:TELEGRAM_BOT_TOKEN` and `$env:TELEGRAM_CHAT_ID` for
Telegram, `$env:WATCHTOWER_PGLITE_DIR = "data\db1"` to keep history between restarts. The relayer can also come
from `$env:RELAYER_ACCOUNT_ID` and `$env:RELAYER_SECRET_KEY`.

## Step 5: show it live

```powershell
$env:WATCHTOWER_LIVE = "testnet:watchtower.you.testnet"
npm run app
Start-Process .\apps\status\dist\site\index.html
```

The page now opens on your contract instead of a replay. There is no play button in live mode: it shows the
contract's current verdicts and refreshes every 20 seconds. The replays stay available under Data source, as
history. AI agents can use it too: `npm run build:mcp`, then start the MCP server with `--live testnet --contract
watchtower.you.testnet`.

## Step 6: the shadow week

Leave the watchers running and check each day:

- `npm run doctor` stays green
- routes you know are healthy stay green; nothing goes red without a reason you can find on-chain
- the three watchers agree (the Watchers page shows any disagreement, and the contract logs it)
- the relayer account keeps enough NEAR for gas

## Step 7: mainnet

Only after the shadow week looks right:

1. `npm run deploy`, answer **mainnet**. It asks you to type the contract name to confirm. Storage costs about
   1 NEAR per 100 KB of contract code (the script prints the exact size); keep a few extra NEAR for state and gas
2. prefer a reproducible build (`cargo near build reproducible-wasm`, needs Docker) so anyone can verify the code
3. run the three watchers on three machines with different RPC providers, each with its own relayer balance
4. move the owner role to a multisig or DAO and add guardians who can pause
5. publish the contract id in the README and point the SDK at it: `new Watchtower({ network: "mainnet", contractId: "watchtower.you.near" })`

The name `watchtower.near` in the examples is a placeholder; your contract will be `watchtower.<your account>.near`.

## If something goes wrong

| Message | What to do |
| --- | --- |
| `near` or `cargo` is not recognized | Open a **new** PowerShell window after installing; installers update PATH only for new windows |
| `Could not resolve host: static.crates.io`, `Connection was reset`, or "Cargo.toml is likely malformed" during the build | Your connection dropped while Rust downloaded the contract's libraries; the Cargo.toml is fine. Check the connection and run `npm run deploy` again: finished downloads are kept |
| The cargo-near installer prints nothing for minutes | Press Ctrl+C and run it again. If it still hangs: `rustup update stable`, then `cargo +stable install --locked cargo-near` (compiles it, 5–10 minutes) |
| `rustc 1.xx is not supported` / `requires rustc 1.95` | Something built with your default Rust instead of the pinned one. Run the build from `contracts\watchtower`, or set `$env:RUSTUP_TOOLCHAIN = "1.97.0"` |
| `can't find crate for core` / `wasm32-unknown-unknown` | `rustup target add wasm32-unknown-unknown --toolchain 1.97.0` |
| `CompilationError(PrepareError(...))` after deploying | The network refused a WebAssembly feature in the build. Update cargo-near (run its installer again) and deploy again; if it persists, keep the full message, which names the feature |
| `LNK2019: unresolved external symbol value_return` … `LNK1120` while "Generating ABI" | Windows can't link cargo-near's optional ABI step. `npm run deploy` skips it on Windows; by hand, add `--no-abi` |
| `link.exe not found` | Install the Visual Studio C++ Build Tools (the Rust installer offers them) |
| `-429 … THIS ENDPOINT IS DEPRECATED` | `rpc.mainnet.near.org` and `rpc.testnet.near.org` are retired. Watchtower now uses FastNEAR (`free.rpc.fastnear.com`, `test.rpc.fastnear.com`) and upgrades old configs automatically; set `rpcUrl` / `live.near.rpcUrl` to another provider from docs.near.org/api/rpc/providers if needed |
| `error sending request for url (https://archival-rpc.testnet.fastnear.com/)` | near-cli couldn't reach its RPC: your connection or that provider. Retry; if it keeps failing, `near config edit-connection testnet --key rpc_url --value https://rpc.testnet.near.org/` |
| `Couldn't read <account>` | Import it: `near account import-account using-web-wallet network-config testnet` (or `mainnet`) |
| A step fails halfway | Fix the message and run `npm run deploy` again: finished steps are detected and skipped |



## Data use

Each round a watcher downloads NEAR block data, capped at 1 MB by default (about 1.4 GB a day). Reading every block
takes about 50 MB a minute, and verdicts don't need every block. Raise the cap for one watcher on an unlimited
connection with `npm run watch:1 -- --data-mb 20`, or set `WATCHTOWER_DATA_MB`. Watchers on the same PC share
downloaded blocks through `data/near-cache`.
