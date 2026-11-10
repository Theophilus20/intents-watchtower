#!/usr/bin/env bash
# Deploy watchtower to NEAR testnet and register three watchers with quorum 2.
# Requires near-cli-rs (https://github.com/near/near-cli-rs) and cargo-near, and an owner
# account whose key is in your keychain:  near account import-account ... network-config testnet
#
#   OWNER=you.testnet ./scripts/deploy-testnet.sh
set -euo pipefail
OWNER="${OWNER:?set OWNER=<your testnet account>}"
CONTRACT="${CONTRACT:-watchtower.$OWNER}"
NET=testnet
cd "$(dirname "$0")/.."

echo "› building wasm"
(cd contracts/watchtower && cargo near build non-reproducible-wasm)
WASM=contracts/watchtower/target/near/watchtower.wasm

if ! near account view-account-summary "$CONTRACT" network-config $NET now >/dev/null 2>&1; then
  echo "› creating $CONTRACT"
  near account create-account fund-myself "$CONTRACT" '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as "$OWNER" network-config $NET sign-with-keychain send
fi

echo "› deploying"
near contract deploy "$CONTRACT" use-file "$WASM" \
  with-init-call new json-args "{\"owner_id\":\"$OWNER\",\"quorum\":1}" \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config $NET sign-with-keychain send

mkdir -p data
for i in 1 2 3; do
  KEYFILE="data/watcher-$i.json"
  [ -f "$KEYFILE" ] || npx tsx packages/watcher/src/cli.ts keygen | head -4 > "$KEYFILE"
  PK=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$KEYFILE','utf8')).public_key)")
  echo "› add_watcher w$i.$CONTRACT ($PK)"
  near contract call-function as-transaction "$CONTRACT" add_watcher \
    json-args "{\"account_id\":\"w$i.$CONTRACT\",\"public_key\":\"$PK\"}" \
    prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config $NET sign-with-keychain send
done

echo "› quorum 2, escalation 1"
near contract call-function as-transaction "$CONTRACT" set_quorum json-args '{"quorum":2,"escalation_threshold":1}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as "$OWNER" network-config $NET sign-with-keychain send

near contract call-function as-read-only "$CONTRACT" get_config json-args '{}' network-config $NET now
echo "✓ $CONTRACT ready. Watcher keys are in data/watcher-*.json (keep them secret)."
