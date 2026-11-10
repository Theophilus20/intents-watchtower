use near_sdk::json_types::{Base64VecU8, U64};
use near_sdk::{near, AccountId, PublicKey};

/// Route health status. Order matters: it is the severity rank used for escalation.
/// Unknown sits between Amber and Red: it is never safe.
#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Green,
    Amber,
    Unknown,
    Red,
}

impl Status {
    pub fn rank(self) -> u8 {
        match self {
            Status::Green => 0,
            Status::Amber => 1,
            Status::Unknown => 2,
            Status::Red => 3,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Green => "green",
            Status::Amber => "amber",
            Status::Unknown => "unknown",
            Status::Red => "red",
        }
    }
}

/// What watchers sign and the contract stores per route.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteHealth {
    pub status: Status,
    /// 0..=100
    pub score: u8,
    /// Safe size: the most (whole USD) that can move through the route right now. 0 = blocked.
    pub capacity_usd: u64,
    /// Reason codes, optionally "CODE:subject", e.g. "GHOST_CREDIT:usdt:bsc".
    pub reasons: Vec<String>,
    /// Observation epoch (minutes since Unix epoch by default).
    pub epoch: u64,
    /// sha256 (hex) of the full off-chain report; anyone can recompute it.
    pub report_hash: String,
    /// Watchers whose signatures produced this state.
    pub signers: u8,
    /// Block time the contract applied it.
    pub updated_at_ns: U64,
}

/// The verdict a set of watchers attest to. Same fields as RouteHealth, minus contract bookkeeping.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ReportInput {
    pub epoch: u64,
    pub status: Status,
    pub score: u8,
    pub capacity_usd: u64,
    pub reasons: Vec<String>,
    pub report_hash: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AttestationInput {
    pub watcher_id: AccountId,
    /// ed25519 signature over the attestation line (see attestation.rs).
    pub signature: Base64VecU8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Watcher {
    pub public_key: PublicKey,
    pub added_at_ns: U64,
    pub attestations: u64,
    pub last_epoch: u64,
}

#[near(serializers = [json])]
pub struct WatcherView {
    pub account_id: AccountId,
    pub public_key: PublicKey,
    pub added_at_ns: U64,
    pub attestations: u64,
    pub last_epoch: u64,
}

/// A candidate verdict collecting votes. Several can coexist for a route when watchers disagree.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Round {
    pub epoch: u64,
    pub status: Status,
    pub score: u8,
    pub capacity_usd: u64,
    pub reasons: Vec<String>,
    pub report_hash: String,
    pub voters: Vec<AccountId>,
    pub first_seen_ns: U64,
}

/// One route's report inside a `submit_reports` batch.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BatchReport {
    pub route_id: String,
    pub report: ReportInput,
    pub attestations: Vec<AttestationInput>,
}

#[near(serializers = [json])]
pub struct SubmitOutcome {
    /// True if this call changed (or refreshed) the route's stored health.
    pub applied: bool,
    pub votes: u8,
    pub needed: u8,
    pub status: Option<Status>,
}

/// Rich answer for agents: the yes/no plus why.
#[near(serializers = [json])]
pub struct SafetyCheck {
    pub route_id: String,
    pub safe: bool,
    /// "ok" | "paused" | "override" | "no_data" | "stale" | "status"
    pub verdict: String,
    pub status: Option<Status>,
    pub score: Option<u8>,
    pub capacity_usd: Option<u64>,
    pub reasons: Vec<String>,
    pub age_sec: Option<u64>,
    pub report_hash: Option<String>,
}

/// Size-aware answer: safe AND the amount fits the signed safe size.
#[near(serializers = [json])]
pub struct IntentCheck {
    pub route_id: String,
    pub amount_usd: u64,
    pub allowed: bool,
    pub safe: bool,
    /// Same values as SafetyCheck, plus "over_capacity" when the route is safe but too small.
    pub verdict: String,
    pub status: Option<Status>,
    pub score: Option<u8>,
    pub capacity_usd: Option<u64>,
    pub reasons: Vec<String>,
    pub age_sec: Option<u64>,
    pub report_hash: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub id: u64,
    pub route_id: String,
    pub intent_hash: String,
    pub caller: AccountId,
    pub safe: bool,
    pub status: Option<Status>,
    pub score: Option<u8>,
    pub epoch: Option<u64>,
    pub report_hash: Option<String>,
    pub at_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Override {
    pub status: Status,
    pub note: String,
    pub by: AccountId,
    pub at_ns: U64,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner_id: AccountId,
    pub guardians: Vec<AccountId>,
    pub quorum: u8,
    pub escalation_threshold: u8,
    pub watcher_count: u32,
    pub route_count: u32,
    pub epoch_ms: u64,
    pub max_report_age_sec: u64,
    pub default_max_age_sec: u64,
    pub paused: bool,
    pub receipts: u64,
    pub version: String,
}
