# watchtower.near

Route-health oracle and circuit breaker for NEAR Intents. See the repository README for the design; this file covers building and calling it.

```bash
cargo test                                  # 25 unit tests, including TypeScript-signed vectors
cargo near build non-reproducible-wasm      # target/near/watchtower.wasm
```

## Call it from another contract

```rust
use near_sdk::{ext_contract, near, Promise, PromiseError};

#[ext_contract(watchtower)]
trait Watchtower {
    fn is_safe(&self, route_id: String, max_age_sec: Option<u64>, allow_amber: Option<bool>) -> bool;
}

#[near]
impl MyRouter {
    pub fn swap(&mut self, route_id: String, amount: near_sdk::json_types::U128) -> Promise {
        watchtower::ext("watchtower.near".parse().unwrap())
            .is_safe(route_id.clone(), Some(300), Some(false))
            .then(Self::ext(near_sdk::env::current_account_id()).swap_if_safe(route_id, amount))
    }

    #[private]
    pub fn swap_if_safe(&mut self, route_id: String, amount: near_sdk::json_types::U128, #[callback_result] safe: Result<bool, PromiseError>) {
        near_sdk::require!(safe == Ok(true), "route not safe right now"); // unreachable oracle = not safe
        // ... execute the swap
    }
}
```

## From the CLI

```bash
near contract call-function as-read-only watchtower.testnet check_route \
  json-args '{"route_id":"btc:bitcoin->usdc:near"}' network-config testnet now

# Size-aware: may $50,000 move through this route right now?
near contract call-function as-read-only watchtower.testnet check_intent \
  json-args '{"route_id":"btc:bitcoin->usdc:near","amount_usd":50000}' network-config testnet now
```
