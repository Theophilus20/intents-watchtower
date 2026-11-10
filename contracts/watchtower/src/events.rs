//! NEP-297 events. Indexers, bots and the status page subscribe to these.

use crate::types::Status;
use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "watchtower";
pub const VERSION: &str = "1.0.0";

fn emit(event: &str, data: Value) {
    let payload =
        json!({ "standard": STANDARD, "version": VERSION, "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

pub fn route_health_updated(
    route_id: &str,
    from: Option<Status>,
    to: Status,
    epoch: u64,
    report_hash: &str,
    signers: u8,
    reasons: &[String],
) {
    emit(
        "route_health_updated",
        json!({ "route_id": route_id, "from": from.map(|s| s.as_str()), "to": to.as_str(), "epoch": epoch, "report_hash": report_hash, "signers": signers, "reasons": reasons }),
    );
}

pub fn watcher_disagreement(route_id: &str, epoch: u64, hashes: &[String]) {
    emit(
        "watcher_disagreement",
        json!({ "route_id": route_id, "epoch": epoch, "report_hashes": hashes }),
    );
}

pub fn receipt_recorded(id: u64, route_id: &str, intent_hash: &str, safe: bool) {
    emit(
        "safety_receipt",
        json!({ "id": id, "route_id": route_id, "intent_hash": intent_hash, "safe": safe }),
    );
}

pub fn admin(action: &str, detail: Value) {
    emit("admin", json!({ "action": action, "detail": detail }));
}
