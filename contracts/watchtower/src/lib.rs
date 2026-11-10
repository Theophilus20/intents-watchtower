//! # watchtower.near
//!
//! The on-chain half of Intents Watchtower: a route-health oracle and circuit breaker for
//! NEAR Intents. Independent watchers compute the same deterministic report off-chain, sign it,
//! and anyone relays the signatures here. Apps, wallets and AI agents ask one free view call
//! before they move money:
//!
//! ```text
//! is_safe("btc:bitcoin->usdc:near", 300, false) -> bool
//! ```
//!
//! Safety properties
//! - **Fail-closed.** No data, stale data, unknown status, paused contract: `is_safe` is false.
//! - **Fast red, slow green.** Raising the alarm needs `escalation_threshold` signatures (1 by
//!   default); lowering it, or keeping a non-red status fresh, needs `quorum`. One honest
//!   watcher can always pull the alarm; one compromised watcher can never silence it.
//! - **Unreplayable signatures.** Each signature binds contract, route, epoch and full verdict.
//! - **Monotonic epochs.** A route never moves back in time; stale reports are rejected.
//! - **Verifiable.** Only the report hash is stored; the full report lives off-chain and anyone
//!   can recompute the hash.

mod attestation;
mod events;
mod types;

pub use crate::types::*;

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, IterableSet, LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PublicKey,
};

const MAX_VOTES_PER_ROUTE: usize = 32;
const MAX_ATTESTATIONS: usize = 32;
const MAX_BATCH: usize = 32;
const MAX_ROUTES: u32 = 1_024;
const MAX_FUTURE_SKEW_MS: u64 = 120_000;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Watchers,
    Guardians,
    Routes,
    Rounds,
    Receipts,
    Overrides,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Watchtower {
    owner_id: AccountId,
    guardians: IterableSet<AccountId>,
    watchers: IterableMap<AccountId, Watcher>,
    quorum: u8,
    escalation_threshold: u8,
    routes: IterableMap<String, RouteHealth>,
    rounds: LookupMap<String, Vec<Round>>,
    receipts: Vector<Receipt>,
    overrides: LookupMap<String, Override>,
    /// Length of one epoch; the TS engine uses one-minute steps.
    epoch_ms: u64,
    /// Reports whose epoch is older than this are rejected.
    max_report_age_sec: u64,
    /// `is_safe` default freshness when the caller passes none.
    default_max_age_sec: u64,
    paused: bool,
}

#[near]
impl Watchtower {
    #[init]
    pub fn new(
        owner_id: AccountId,
        quorum: u8,
        escalation_threshold: Option<u8>,
        epoch_ms: Option<u64>,
    ) -> Self {
        require!(quorum >= 1, "quorum must be >= 1");
        let esc = escalation_threshold.unwrap_or(1);
        require!(
            esc >= 1 && esc <= quorum,
            "escalation_threshold must be 1..=quorum"
        );
        Self {
            owner_id,
            guardians: IterableSet::new(Key::Guardians),
            watchers: IterableMap::new(Key::Watchers),
            quorum,
            escalation_threshold: esc,
            routes: IterableMap::new(Key::Routes),
            rounds: LookupMap::new(Key::Rounds),
            receipts: Vector::new(Key::Receipts),
            overrides: LookupMap::new(Key::Overrides),
            epoch_ms: epoch_ms.unwrap_or(60_000),
            max_report_age_sec: 900,
            default_max_age_sec: 300,
            paused: false,
        }
    }

    // ------------------------------------------------------------------------------------
    // Reads (free view calls)
    // ------------------------------------------------------------------------------------

    /// True only if the route is Green (or Amber when `allow_amber`) and its observation is
    /// younger than `max_age_sec`. Fail-closed: anything else is false.
    pub fn is_safe(
        &self,
        route_id: String,
        max_age_sec: Option<u64>,
        allow_amber: Option<bool>,
    ) -> bool {
        self.check_route(route_id, max_age_sec, allow_amber).safe
    }

    /// The same decision as `is_safe`, plus the reason, so an agent can log or reroute.
    pub fn check_route(
        &self,
        route_id: String,
        max_age_sec: Option<u64>,
        allow_amber: Option<bool>,
    ) -> SafetyCheck {
        let max_age = max_age_sec.unwrap_or(self.default_max_age_sec);
        let mut out = SafetyCheck {
            route_id: route_id.clone(),
            safe: false,
            verdict: "ok".into(),
            status: None,
            score: None,
            capacity_usd: None,
            reasons: vec![],
            age_sec: None,
            report_hash: None,
        };
        if self.paused {
            out.verdict = "paused".into();
            return out;
        }
        if let Some(o) = self.overrides.get(&route_id) {
            out.verdict = "override".into();
            out.status = Some(o.status);
            out.reasons = vec![format!("GUARDIAN_OVERRIDE:{}", o.note)];
            out.safe = matches!(o.status, Status::Green)
                || (o.status == Status::Amber && allow_amber.unwrap_or(false));
            return out;
        }
        let Some(h) = self.routes.get(&route_id) else {
            out.verdict = "no_data".into();
            return out;
        };
        let age = self.age_sec(h.epoch);
        out.status = Some(h.status);
        out.score = Some(h.score);
        out.capacity_usd = Some(h.capacity_usd);
        out.reasons = h.reasons.clone();
        out.age_sec = Some(age);
        out.report_hash = Some(h.report_hash.clone());
        if age > max_age {
            out.verdict = "stale".into();
            return out;
        }
        out.safe = match h.status {
            Status::Green => true,
            Status::Amber => allow_amber.unwrap_or(false),
            Status::Unknown | Status::Red => false,
        };
        if !out.safe {
            out.verdict = "status".into();
        }
        out
    }

    /// Size-aware check for one intent: allowed only if the route is safe AND `amount_usd`
    /// fits the safe size the watchers signed. A safe route that is too small for the amount
    /// answers verdict "over_capacity", so an agent can split the order or reroute instead.
    pub fn check_intent(
        &self,
        route_id: String,
        amount_usd: u64,
        max_age_sec: Option<u64>,
        allow_amber: Option<bool>,
    ) -> IntentCheck {
        let c = self.check_route(route_id, max_age_sec, allow_amber);
        let fits = c.capacity_usd.is_some_and(|cap| amount_usd <= cap);
        let verdict = if c.safe && !fits {
            "over_capacity".to_string()
        } else {
            c.verdict
        };
        IntentCheck {
            route_id: c.route_id,
            amount_usd,
            allowed: c.safe && fits,
            safe: c.safe,
            verdict,
            status: c.status,
            score: c.score,
            capacity_usd: c.capacity_usd,
            reasons: c.reasons,
            age_sec: c.age_sec,
            report_hash: c.report_hash,
        }
    }

    /// Check several routes at once.
    pub fn check_routes(
        &self,
        route_ids: Vec<String>,
        max_age_sec: Option<u64>,
        allow_amber: Option<bool>,
    ) -> Vec<SafetyCheck> {
        require!(route_ids.len() <= 64, "at most 64 routes per call");
        route_ids
            .into_iter()
            .map(|r| self.check_route(r, max_age_sec, allow_amber))
            .collect()
    }

    /// Among candidate routes, the safe one with the highest score (first wins ties).
    pub fn safest_route(
        &self,
        candidates: Vec<String>,
        max_age_sec: Option<u64>,
        allow_amber: Option<bool>,
    ) -> Option<String> {
        require!(candidates.len() <= 64, "at most 64 candidates");
        let mut best: Option<(String, u8)> = None;
        for r in candidates {
            let c = self.check_route(r.clone(), max_age_sec, allow_amber);
            if c.safe {
                let score = c.score.unwrap_or(0);
                if best.as_ref().is_none_or(|(_, s)| score > *s) {
                    best = Some((r, score));
                }
            }
        }
        best.map(|(r, _)| r)
    }

    pub fn get_route_health(&self, route_id: String) -> Option<RouteHealth> {
        self.routes.get(&route_id).cloned()
    }

    pub fn list_routes(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<(String, RouteHealth)> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(200) as usize;
        self.routes
            .iter()
            .skip(from)
            .take(limit)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Each watcher's latest vote for a route (one entry per watcher, `voters` holds its id).
    /// Different statuses among fresh votes mean the watchers disagree.
    pub fn get_pending_rounds(&self, route_id: String) -> Vec<Round> {
        self.votes_of(&route_id)
    }

    pub fn get_watchers(&self) -> Vec<WatcherView> {
        self.watchers
            .iter()
            .map(|(id, w)| WatcherView {
                account_id: id.clone(),
                public_key: w.public_key.clone(),
                added_at_ns: w.added_at_ns,
                attestations: w.attestations,
                last_epoch: w.last_epoch,
            })
            .collect()
    }

    pub fn get_receipt(&self, id: u64) -> Option<Receipt> {
        if id >= self.receipts.len() as u64 {
            return None;
        }
        self.receipts.get(id as u32).cloned()
    }

    pub fn get_override(&self, route_id: String) -> Option<Override> {
        self.overrides.get(&route_id).cloned()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner_id: self.owner_id.clone(),
            guardians: self.guardians.iter().cloned().collect(),
            quorum: self.quorum,
            escalation_threshold: self.escalation_threshold,
            watcher_count: self.watchers.len(),
            route_count: self.routes.len(),
            epoch_ms: self.epoch_ms,
            max_report_age_sec: self.max_report_age_sec,
            default_max_age_sec: self.default_max_age_sec,
            paused: self.paused,
            receipts: self.receipts.len() as u64,
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    /// The exact line a watcher must sign for this report (debugging aid for integrators).
    pub fn attestation_message(&self, route_id: String, report: ReportInput) -> String {
        attestation::message(env::current_account_id().as_str(), &route_id, &report)
    }

    // ------------------------------------------------------------------------------------
    // Watcher reports
    // ------------------------------------------------------------------------------------

    /// Submit a verdict with one or more watcher signatures. Callable by anyone (watchers or a
    /// relayer): authority comes from the signatures, not from who pays the gas.
    pub fn submit_report(
        &mut self,
        route_id: String,
        report: ReportInput,
        attestations: Vec<AttestationInput>,
    ) -> SubmitOutcome {
        attestation::assert_valid_route(&route_id);
        attestation::assert_valid_report(&report);
        require!(
            !attestations.is_empty() && attestations.len() <= MAX_ATTESTATIONS,
            "1..=32 attestations required"
        );

        // Time checks: reports describe a recent epoch, never the future, never the past of this route.
        let now_ms = env::block_timestamp_ms();
        let obs_ms = report
            .epoch
            .checked_mul(self.epoch_ms)
            .unwrap_or_else(|| env::panic_str("epoch overflow"));
        require!(
            obs_ms <= now_ms + MAX_FUTURE_SKEW_MS,
            "report epoch is in the future"
        );
        require!(
            now_ms.saturating_sub(obs_ms) <= self.max_report_age_sec * 1000,
            "report is too old"
        );
        let current = self.routes.get(&route_id).cloned();
        if current.is_none() {
            require!(self.routes.len() < MAX_ROUTES, "route limit reached");
        }

        // Verify every signature against the registered watcher key.
        let msg = attestation::message(env::current_account_id().as_str(), &route_id, &report);
        let mut signers: Vec<AccountId> = Vec::with_capacity(attestations.len());
        for a in &attestations {
            require!(
                !signers.contains(&a.watcher_id),
                "duplicate watcher in attestations"
            );
            let w = self.watchers.get(&a.watcher_id).unwrap_or_else(|| {
                env::panic_str(&format!("{} is not a registered watcher", a.watcher_id))
            });
            require!(
                attestation::verify(&w.public_key, &a.signature.0, &msg),
                format!("invalid signature from {}", a.watcher_id)
            );
            signers.push(a.watcher_id.clone());
        }
        for id in &signers {
            if let Some(w) = self.watchers.get_mut(id) {
                w.attestations += 1;
                w.last_epoch = w.last_epoch.max(report.epoch);
            }
        }

        // Each signer's latest vote replaces its previous one. Watchers read live chains seconds
        // apart, so their report hashes never match exactly: they must agree on the verdict
        // (status), not on every byte of the data behind it.
        let mut votes = self.votes_of(&route_id);
        let mut changed_vote = false;
        for id in &signers {
            if let Some(i) = votes.iter().position(|v| v.voters.first() == Some(id)) {
                if votes[i].epoch > report.epoch {
                    continue; // this watcher already said something newer
                }
                changed_vote |= votes[i].status != report.status;
                votes.remove(i);
            } else {
                changed_vote = true;
            }
            votes.push(Round {
                epoch: report.epoch,
                status: report.status,
                score: report.score,
                capacity_usd: report.capacity_usd,
                reasons: report.reasons.clone(),
                report_hash: report.report_hash.clone(),
                voters: vec![id.clone()],
                first_seen_ns: U64(env::block_timestamp()),
            });
        }
        votes.retain(|v| {
            v.voters
                .first()
                .is_some_and(|w| self.watchers.get(w).is_some())
        });
        votes.sort_by_key(|v| std::cmp::Reverse(v.epoch));
        votes.truncate(MAX_VOTES_PER_ROUTE);

        let fresh: Vec<&Round> = votes
            .iter()
            .filter(|v| self.age_sec(v.epoch) <= self.default_max_age_sec)
            .collect();
        if changed_vote && fresh.iter().any(|v| v.status != report.status) {
            let hashes: Vec<String> = fresh.iter().map(|v| v.report_hash.clone()).collect();
            events::watcher_disagreement(&route_id, report.epoch, &hashes);
        }

        let agreeing = fresh.iter().filter(|v| v.status == report.status).count() as u8;
        let needed = if report.status == Status::Green {
            self.quorum
        } else {
            self.escalation_threshold
        };
        let mut applied = false;
        if let Some((status, set)) = self.decide(&fresh) {
            let same: Vec<&&Round> = set.iter().filter(|v| v.status == status).collect();
            let rep = same
                .iter()
                .max_by_key(|v| v.epoch)
                .copied()
                .unwrap_or(&set[0]);
            let health = RouteHealth {
                status,
                // The most cautious of the agreeing watchers.
                score: same.iter().map(|v| v.score).min().unwrap_or(rep.score),
                capacity_usd: if status.rank() >= Status::Unknown.rank() {
                    0
                } else {
                    same.iter().map(|v| v.capacity_usd).min().unwrap_or(0)
                },
                reasons: rep.reasons.clone(),
                // Green is only as fresh as the oldest of the newest `quorum` votes behind it.
                epoch: if status == Status::Green {
                    set.get(self.quorum as usize - 1)
                        .map(|v| v.epoch)
                        .unwrap_or(rep.epoch)
                } else {
                    rep.epoch
                },
                report_hash: rep.report_hash.clone(),
                signers: set.len() as u8,
                updated_at_ns: U64(env::block_timestamp()),
            };
            let from = current.as_ref().map(|c| c.status);
            let unchanged = current.as_ref().is_some_and(|c| {
                c.status == health.status
                    && c.epoch == health.epoch
                    && c.report_hash == health.report_hash
                    && c.capacity_usd == health.capacity_usd
                    && c.score == health.score
                    && c.signers == health.signers
            });
            if from != Some(status) {
                events::route_health_updated(
                    &route_id,
                    from,
                    status,
                    health.epoch,
                    &health.report_hash,
                    health.signers,
                    &health.reasons,
                );
            }
            if !unchanged {
                self.routes.insert(route_id.clone(), health);
                applied = true;
            }
        }

        if votes.is_empty() {
            self.rounds.remove(&route_id);
        } else {
            self.rounds.insert(route_id.clone(), votes);
        }

        SubmitOutcome {
            applied,
            votes: agreeing,
            needed,
            status: self.routes.get(&route_id).map(|h| h.status),
        }
    }

    /// A whole round in one transaction: one report per route, each checked exactly as
    /// `submit_report` would. Paying one transaction instead of one per route is what makes
    /// running a watcher affordable. Anything invalid, such as a bad signature, fails the whole
    /// call. (Entries are `Option` for compatibility; they are always filled.)
    pub fn submit_reports(&mut self, reports: Vec<BatchReport>) -> Vec<Option<SubmitOutcome>> {
        require!(
            !reports.is_empty() && reports.len() <= MAX_BATCH,
            "1..=32 reports per batch"
        );
        reports
            .into_iter()
            .map(|r| Some(self.submit_report(r.route_id, r.report, r.attestations)))
            .collect()
    }

    /// The verdict from each watcher's latest fresh vote. Fast red, slow green:
    /// - Red, then Amber, as soon as `escalation_threshold` watchers say so: an alarm only makes
    ///   callers more careful, and it lasts while the watcher that raised it still asserts it.
    /// - Green when `quorum` watchers agree and no alarm stands. A watcher that can't see
    ///   (Unknown) doesn't block watchers that can.
    /// - Unknown when `escalation_threshold` watchers can't see and nothing above applies.
    /// - Otherwise no decision: the stored verdict stands until it goes stale.
    fn decide<'a>(&self, fresh: &[&'a Round]) -> Option<(Status, Vec<&'a Round>)> {
        let pick = |f: fn(Status) -> bool| -> Vec<&'a Round> {
            fresh.iter().copied().filter(|v| f(v.status)).collect()
        };
        let red = pick(|s| s == Status::Red);
        if red.len() as u8 >= self.escalation_threshold {
            return Some((Status::Red, red));
        }
        let warn = pick(|s| s == Status::Red || s == Status::Amber);
        if warn.len() as u8 >= self.escalation_threshold {
            return Some((Status::Amber, warn));
        }
        let mut greens = pick(|s| s == Status::Green);
        if greens.len() as u8 >= self.quorum {
            greens.sort_by_key(|v| std::cmp::Reverse(v.epoch));
            return Some((Status::Green, greens));
        }
        let unknown = pick(|s| s == Status::Unknown);
        if unknown.len() as u8 >= self.escalation_threshold {
            return Some((Status::Unknown, unknown));
        }
        None
    }

    /// Latest vote per watcher for a route. Older contract versions kept rounds with several
    /// voters; each voter of those counts as one vote here.
    fn votes_of(&self, route_id: &str) -> Vec<Round> {
        let mut out: Vec<Round> = vec![];
        for r in self.rounds.get(route_id).cloned().unwrap_or_default() {
            for w in &r.voters {
                let vote = Round {
                    voters: vec![w.clone()],
                    ..r.clone()
                };
                match out.iter().position(|v| v.voters.first() == Some(w)) {
                    Some(i) if out[i].epoch >= r.epoch => {}
                    Some(i) => out[i] = vote,
                    None => out.push(vote),
                }
            }
        }
        out
    }

    // ------------------------------------------------------------------------------------
    // Safety receipts
    // ------------------------------------------------------------------------------------

    /// Record what the route looked like at the moment a swap executed. The caller pays for
    /// the storage it uses; any excess deposit is refunded.
    #[payable]
    pub fn record_receipt(
        &mut self,
        route_id: String,
        intent_hash: String,
        max_age_sec: Option<u64>,
        allow_amber: Option<bool>,
    ) -> u64 {
        require!(
            !intent_hash.is_empty() && intent_hash.len() <= 128,
            "intent_hash must be 1..=128 chars"
        );
        require!(
            route_id.len() <= attestation::MAX_ROUTE_LEN,
            "route_id too long"
        );
        let before = env::storage_usage();
        let check = self.check_route(route_id.clone(), max_age_sec, allow_amber);
        let id = self.receipts.len() as u64;
        let epoch = self.routes.get(&route_id).map(|h| h.epoch);
        self.receipts.push(Receipt {
            id,
            route_id: route_id.clone(),
            intent_hash: intent_hash.clone(),
            caller: env::predecessor_account_id(),
            safe: check.safe,
            status: check.status,
            score: check.score,
            epoch,
            report_hash: check.report_hash,
            at_ns: U64(env::block_timestamp()),
        });
        self.receipts.flush();
        let used = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(used as u128);
        let attached = env::attached_deposit();
        require!(
            attached >= cost,
            format!(
                "attach at least {} yoctoNEAR for receipt storage",
                cost.as_yoctonear()
            )
        );
        let refund = attached.saturating_sub(cost);
        if refund > NearToken::from_yoctonear(0) {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
        events::receipt_recorded(id, &route_id, &intent_hash, check.safe);
        id
    }

    // ------------------------------------------------------------------------------------
    // Guardian: emergency controls (fail-closed only — a guardian can never make a route look safer)
    // ------------------------------------------------------------------------------------

    pub fn pause(&mut self) {
        self.assert_guardian();
        self.paused = true;
        events::admin("pause", json!({ "by": env::predecessor_account_id() }));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        events::admin("unpause", json!({ "by": env::predecessor_account_id() }));
    }

    /// Force a route to Amber, Unknown or Red until cleared. Green overrides are refused.
    pub fn set_override(&mut self, route_id: String, status: Status, note: String) {
        self.assert_guardian();
        attestation::assert_valid_route(&route_id);
        require!(
            status != Status::Green,
            "overrides can only make a route less safe"
        );
        require!(
            note.len() <= 64
                && note
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_-.".contains(&b)),
            "note: <=64 chars of [a-z0-9_-.]"
        );
        self.overrides.insert(
            route_id.clone(),
            Override {
                status,
                note: note.clone(),
                by: env::predecessor_account_id(),
                at_ns: U64(env::block_timestamp()),
            },
        );
        events::admin(
            "set_override",
            json!({ "route_id": route_id, "status": status.as_str(), "note": note }),
        );
    }

    pub fn clear_override(&mut self, route_id: String) {
        self.assert_owner();
        self.overrides.remove(&route_id);
        events::admin("clear_override", json!({ "route_id": route_id }));
    }

    // ------------------------------------------------------------------------------------
    // Owner administration (moves to DAO governance after the MVP)
    // ------------------------------------------------------------------------------------

    pub fn add_watcher(&mut self, account_id: AccountId, public_key: PublicKey) {
        self.assert_owner();
        require!(
            public_key.curve_type() == near_sdk::CurveType::ED25519,
            "watcher keys must be ed25519"
        );
        self.watchers.insert(
            account_id.clone(),
            Watcher {
                public_key: public_key.clone(),
                added_at_ns: U64(env::block_timestamp()),
                attestations: 0,
                last_epoch: 0,
            },
        );
        events::admin(
            "add_watcher",
            json!({ "account_id": account_id, "public_key": public_key }),
        );
    }

    pub fn remove_watcher(&mut self, account_id: AccountId) {
        self.assert_owner();
        require!(self.watchers.remove(&account_id).is_some(), "not a watcher");
        require!(
            self.watchers.len() >= self.quorum as u32,
            "removing this watcher would make quorum unreachable; lower quorum first"
        );
        events::admin("remove_watcher", json!({ "account_id": account_id }));
    }

    pub fn set_quorum(&mut self, quorum: u8, escalation_threshold: Option<u8>) {
        self.assert_owner();
        require!(
            quorum >= 1 && quorum as u32 <= self.watchers.len().max(1),
            "quorum must be 1..=watcher count"
        );
        let esc = escalation_threshold.unwrap_or(self.escalation_threshold.min(quorum));
        require!(
            esc >= 1 && esc <= quorum,
            "escalation_threshold must be 1..=quorum"
        );
        self.quorum = quorum;
        self.escalation_threshold = esc;
        events::admin(
            "set_quorum",
            json!({ "quorum": quorum, "escalation_threshold": esc }),
        );
    }

    pub fn set_timing(
        &mut self,
        max_report_age_sec: Option<u64>,
        default_max_age_sec: Option<u64>,
    ) {
        self.assert_owner();
        if let Some(v) = max_report_age_sec {
            require!(
                (60..=86_400).contains(&v),
                "max_report_age_sec must be 60..=86400"
            );
            self.max_report_age_sec = v;
        }
        if let Some(v) = default_max_age_sec {
            require!(
                (30..=86_400).contains(&v),
                "default_max_age_sec must be 30..=86400"
            );
            self.default_max_age_sec = v;
        }
    }

    pub fn add_guardian(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.guardians.insert(account_id);
    }

    pub fn remove_guardian(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.guardians.remove(&account_id);
    }

    pub fn transfer_ownership(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        events::admin(
            "transfer_ownership",
            json!({ "from": self.owner_id, "to": new_owner_id }),
        );
        self.owner_id = new_owner_id;
    }

    // ------------------------------------------------------------------------------------

    fn age_sec(&self, epoch: u64) -> u64 {
        let obs_ms = epoch.saturating_mul(self.epoch_ms);
        env::block_timestamp_ms().saturating_sub(obs_ms) / 1000
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "owner only");
    }

    fn assert_guardian(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || self.guardians.contains(&caller),
            "guardian only"
        );
    }
}

#[cfg(test)]
mod tests;
