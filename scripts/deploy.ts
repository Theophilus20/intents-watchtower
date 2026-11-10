/**
 * Guided deployment of watchtower to NEAR testnet or mainnet. Works the same on Windows, macOS and Linux.
 *
 *   npm run deploy
 *
 * It asks for the network and your account, then: builds the contract, creates the contract
 * account under yours, deploys and initialises it, creates three watcher keys, registers them
 * and sets the quorum to 2 of 3. Every command is printed before it runs, so you can see exactly
 * what it does and re-run any step by hand. Mainnet needs you to type the contract name to confirm.
 *
 * Needs: near-cli-rs (`near`), Rust with cargo-near, and your account imported into near-cli-rs.
 * You can also answer the questions with environment variables: NETWORK, OWNER, CONTRACT, DEPOSIT.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { generateWatcherKey } from "@watchtower/core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
const say = (s = "") => console.log(s);
const step = (s: string) => console.log(`\n\u001b[1m› ${s}\u001b[0m`);
const warn = (s: string) => console.log(`\u001b[33m${s}\u001b[0m`);
const fail = (s: string): never => {
  console.log(`\n\u001b[31m✗ ${s}\u001b[0m`);
  process.exit(1);
};

/** Run a program with arguments. On Windows the shell resolves near.cmd / near.exe; JSON stays one argument. */
function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean; allowFail?: boolean; env?: Record<string, string>; interactive?: boolean } = {}): { ok: boolean; out: string } {
  const shown = [cmd, ...args.map((a) => (/[\s"{}]/.test(a) ? `'${a}'` : a))].join(" ");
  if (!opts.quiet) say(`  $ ${shown}`);
  // Windows: one command line for cmd.exe (it resolves near.cmd / near.exe); JSON keeps its quotes as \".
  const line = [cmd, ...args.map((a) => (/[\s"{}]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(" ");
  const io = { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, encoding: "utf8" as const, stdio: (opts.quiet ? "pipe" : opts.interactive ? "inherit" : ["inherit", "pipe", "pipe"]) as never };
  const r = win ? spawnSync(line, { ...io, shell: true }) : spawnSync(cmd, args, io);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // cargo prints a line per retry; on a flaky connection that is thousands of lines, so show a count instead.
  const retries = (out.match(/spurious network error/g) ?? []).length;
  const shownOut = out.split(/\r?\n/).filter((l) => !l.includes("spurious network error")).join("\n");
  if (!opts.quiet && shownOut.trim()) process.stdout.write(shownOut.replace(/^/gm, "    ") + "\n");
  if (!opts.quiet && retries) warn(`    (${retries} download retries hidden)`);
  const ok = r.status === 0;
  if (!ok && /Could not resolve host|failed to download|Connection was reset|spurious network error/.test(out)) {
    warn("Your internet connection dropped while downloading. Files that finished are kept, so check the connection");
    warn("and run npm run deploy again: it carries on where it stopped. (Ignore any 'Cargo.toml is likely malformed' line.)");
  }
  if (!ok && /PrepareError|CompilationError|Deserialization/.test(out)) {
    warn("NEAR rejected the compiled contract. Update cargo-near (run its installer again), then run npm run deploy again.");
    warn("If it still fails, keep the full message: it names the WebAssembly feature the network refused.");
  }
  if (!ok && /LNK2019|LNK1120|unresolved external symbol/.test(out)) {
    warn("Windows couldn't link the optional ABI step. Build without it:  cargo near build non-reproducible-wasm --no-abi");
  }
  if (!ok && !opts.allowFail) fail(`That step failed. Fix the message above and run npm run deploy again; finished steps are skipped.`);
  return { ok, out };
}

const has = (cmd: string, args: string[]) => run(cmd, args, { quiet: true, allowFail: true }).ok;

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string, env?: string) => {
    const preset = env ? process.env[env] : undefined;
    if (preset) return preset;
    const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
    return a || def || "";
  };

  say("\u001b[1mIntents Watchtower: deploy the contract\u001b[0m");
  say("Answer three questions. Press Enter to accept the value in brackets.\n");

  step("Checking tools");
  const tools: [string, string[], string][] = [
    ["near", ["--version"], win ? "near-cli-rs, in PowerShell:  irm https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.ps1 | iex" : "near-cli-rs:  npm install -g near-cli-rs@latest"],
    ["rustup", ["--version"], "Rust's installer, rustup: https://rustup.rs  (on Windows also the Visual Studio C++ Build Tools)"],
    ["cargo", ["--version"], "Rust: https://rustup.rs  (on Windows also the Visual Studio C++ Build Tools)"],
    ["cargo", ["near", "--version"], win ? "cargo-near, in PowerShell:  irm https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.ps1 | iex   (if that hangs:  rustup update stable  then  cargo +stable install --locked cargo-near)" : "cargo-near:  cargo +stable install --locked cargo-near"],
  ];
  let missing = false;
  for (const [cmd, args, fix] of tools) {
    if (has(cmd, args)) say(`  ✓ ${cmd} ${args[0] === "near" ? "near" : ""}`.trimEnd());
    else { missing = true; warn(`  ✗ ${cmd} ${args.join(" ")} not found. Install: ${fix}`); }
  }
  if (missing) fail("Install the missing tools, open a new terminal, and run npm run deploy again.");

  let network = (await ask("Network (testnet or mainnet)", "testnet", "NETWORK")).toLowerCase();
  // An account typed here instead tells us the network too, so accept it rather than stopping.
  let typedOwner: string | undefined;
  if (/\.(testnet|near)$/.test(network)) {
    typedOwner = network;
    network = network.endsWith(".near") ? "mainnet" : "testnet";
    say(`  Using ${network} with the account ${typedOwner}.`);
  }
  if (network !== "testnet" && network !== "mainnet") fail(`Network must be testnet or mainnet, not "${network}".`);
  const suffix = network === "mainnet" ? ".near" : ".testnet";
  const owner = typedOwner ?? (await ask(`Your NEAR ${network} account (it pays for the deployment)`, undefined, "OWNER"));
  if (!owner || !owner.endsWith(suffix)) fail(`Enter an account that ends in ${suffix}, for example you${suffix}.`);
  const contract = await ask("Contract account to create", `watchtower.${owner}`, "CONTRACT");
  if (!contract.endsWith(`.${owner}`) && contract !== owner) warn(`  ${contract} is not under ${owner}; near-cli-rs can only create sub-accounts of the signer.`);

  step(`Checking that near-cli-rs can sign as ${owner}`);
  const who = run("near", ["account", "view-account-summary", owner, "network-config", network, "now"], { allowFail: true });
  if (!who.ok && /error sending request|timed out|connection|dns error/i.test(who.out)) {
    fail(`Couldn't reach the NEAR ${network} RPC (a connection problem, not your account). Check your internet and run npm run deploy again. If it keeps failing, switch near-cli to another RPC:  near config edit-connection ${network} --key rpc_url --value https://rpc.${network}.near.org/`);
  }
  if (!who.ok) {
    fail(`Couldn't read ${owner} on ${network}. Check the name, then import it once with:  near account import-account using-web-wallet network-config ${network}`);
  }

  // The contract pins its Rust version (near-sdk needs 1.95+). Installing it here leaves the computer's default Rust alone.
  const contractDir = join(root, "contracts/watchtower");
  const rust = /channel\s*=\s*"([^"]+)"/.exec(readFileSync(join(contractDir, "rust-toolchain.toml"), "utf8"))?.[1] ?? "stable";
  step(`Installing Rust ${rust} for the contract (one-time download, about 100 MB; your default Rust stays as it is)`);
  run("rustup", ["toolchain", "install", rust, "--profile", "minimal", "--target", "wasm32-unknown-unknown"]);

  // One connection at a time with generous retries: slower, but survives a weak or shared connection.
  const cargoEnv = { RUSTUP_TOOLCHAIN: rust, CARGO_HTTP_MULTIPLEXING: "false", CARGO_NET_RETRY: "10", CARGO_HTTP_TIMEOUT: "120" };
  step("Downloading the contract's Rust libraries (about 280 small files, once)");
  run("cargo", ["fetch"], { cwd: contractDir, env: cargoEnv });

  step("Building the contract (this takes a few minutes the first time)");
  // cargo-near also builds the contract for this computer to extract its ABI (a JSON list of its methods).
  // On Windows the Microsoft linker refuses that build, because NEAR's host functions only exist on-chain.
  // Nothing in Watchtower uses the ABI, so skip it there; the wasm that gets deployed is the same.
  run("cargo", ["near", "build", "non-reproducible-wasm", ...(win ? ["--no-abi"] : [])], { cwd: contractDir, env: cargoEnv });
  const wasm = join(contractDir, "target/near/watchtower.wasm");
  if (!existsSync(wasm)) fail(`Build finished but ${wasm} is missing.`);
  const kb = statSync(wasm).size / 1024;
  // NEAR charges storage at 1 NEAR per 100 KB; leave room for state and gas.
  const suggested = Math.max(network === "mainnet" ? 3 : 5, Math.ceil(kb / 100) + 2);
  say(`  wasm is ${kb.toFixed(0)} KB, so the contract needs about ${(kb / 100).toFixed(1)} NEAR locked for storage`);
  if (network === "mainnet") warn("  For mainnet, a reproducible build is better for verification: cargo near build reproducible-wasm (needs Docker).");

  const exists = run("near", ["account", "view-account-summary", contract, "network-config", network, "now"], { quiet: true, allowFail: true }).ok;
  if (network === "mainnet") {
    warn(`\nThis deploys to MAINNET with real NEAR from ${owner}.`);
    const typed = await ask(`Type the contract account (${contract}) to continue`);
    if (typed !== contract) fail("Not confirmed. Nothing was changed.");
  }

  if (!exists) {
    const deposit = await ask(`NEAR to move from ${owner} into ${contract}`, String(suggested), "DEPOSIT");
    step(`Creating ${contract}`);
    // near-cli asks which key type to generate; its output must reach the screen so the question is visible.
    say("  If near-cli asks which signature scheme to use, press Enter for ed25519.");
    run("near", ["account", "create-account", "fund-myself", contract, `${deposit} NEAR`, "autogenerate-new-keypair", "save-to-keychain", "sign-as", owner, "network-config", network, "sign-with-keychain", "send"], { interactive: true });
  } else {
    say(`\n  ${contract} already exists; deploying the new code to it.`);
  }

  step("Deploying and initialising");
  const initialised = run("near", ["contract", "call-function", "as-read-only", contract, "get_config", "json-args", "{}", "network-config", network, "now"], { quiet: true, allowFail: true }).ok;
  if (initialised) run("near", ["contract", "deploy", contract, "use-file", wasm, "without-init-call", "network-config", network, "sign-with-keychain", "send"]);
  else run("near", ["contract", "deploy", contract, "use-file", wasm, "with-init-call", "new", "json-args", JSON.stringify({ owner_id: owner, quorum: 1 }), "prepaid-gas", "100.0 Tgas", "attached-deposit", "0 NEAR", "network-config", network, "sign-with-keychain", "send"]);

  step("Creating and registering three watcher keys");
  mkdirSync(join(root, "data"), { recursive: true });
  for (const i of [1, 2, 3]) {
    const file = join(root, `data/watcher-${i}.json`);
    const id = `w${i}.${contract}`;
    let key: { account_id: string; public_key: string; secret_key: string };
    if (existsSync(file)) key = JSON.parse(readFileSync(file, "utf8"));
    else {
      const k = generateWatcherKey();
      key = { account_id: id, public_key: k.publicKey, secret_key: k.secretKey };
      writeFileSync(file, JSON.stringify(key, null, 2));
    }
    run("near", ["contract", "call-function", "as-transaction", contract, "add_watcher", "json-args", JSON.stringify({ account_id: key.account_id, public_key: key.public_key }), "prepaid-gas", "30.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", owner, "network-config", network, "sign-with-keychain", "send"]);
  }

  step("Quorum: 1 signature raises the alarm, 2 of 3 to recover");
  run("near", ["contract", "call-function", "as-transaction", contract, "set_quorum", "json-args", JSON.stringify({ quorum: 2, escalation_threshold: 1 }), "prepaid-gas", "30.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", owner, "network-config", network, "sign-with-keychain", "send"]);
  if (network === "mainnet") {
    step("Mainnet timing: verdicts stay valid 15 minutes, so watchers re-confirm every 10 instead of every 4 (less gas)");
    run("near", ["contract", "call-function", "as-transaction", contract, "set_timing", "json-args", JSON.stringify({ max_report_age_sec: 900, default_max_age_sec: 900 }), "prepaid-gas", "30.0 Tgas", "attached-deposit", "0 NEAR", "sign-as", owner, "network-config", network, "sign-with-keychain", "send"]);
  }
  run("near", ["contract", "call-function", "as-read-only", contract, "get_config", "json-args", "{}", "network-config", network, "now"]);

  const cfgPath = join(root, "watchtower.config.json");
  if (!existsSync(cfgPath)) {
    const example = JSON.parse(readFileSync(join(root, "config/watchtower.example.json"), "utf8"));
    example.contractId = contract;
    example.rpcUrl = network === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com";
    writeFileSync(cfgPath, JSON.stringify(example, null, 2));
    say(`\n  wrote watchtower.config.json for ${contract}; fill in the custody addresses before trusting backing checks`);
  }

  rl.close();
  say(`\n\u001b[32m✓ ${contract} is live on ${network} with 3 watchers, quorum 2 of 3.\u001b[0m`);
  say("Watcher keys are in data/watcher-*.json. Keep them secret and never commit them.\n");
  say("Next:");
  say(`  1. npm run doctor            check the live data sources and custody config`);
  say(`  2. start the watchers        docs/MAINNET.md, step 4`);
  say(`  3. show it in the app        set WATCHTOWER_LIVE=${network}:${contract} and run npm run app`);
}

main().catch((e) => fail(String((e as Error)?.message ?? e)));
