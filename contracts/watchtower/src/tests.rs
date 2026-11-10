use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::json_types::Base64VecU8;
use near_sdk::serde::Deserialize;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{bs58, testing_env, NearToken};

const CONTRACT: &str = "watchtower.near";
const OWNER: &str = "owner.near";
const EPOCH: u64 = 29_843_520;
const ROUTE: &str = "btc:bitcoin->usdc:near";

fn now_ms_for(epoch: u64) -> u64 {
    epoch * 60_000 + 30_000
}

fn set_ctx(predecessor: &str, now_ms: u64, deposit: NearToken) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(now_ms * 1_000_000)
        .attached_deposit(deposit)
        .build());
}

fn at(predecessor: &str, epoch: u64) {
    set_ctx(predecessor, now_ms_for(epoch), NearToken::from_yoctonear(0));
}

struct Keyed {
    id: AccountId,
    sk: SigningKey,
}

impl Keyed {
    fn new(name: &str, seed: u8) -> Self {
        Self {
            id: name.parse().unwrap(),
            sk: SigningKey::from_bytes(&[seed; 32]),
        }
    }
    fn public_key(&self) -> PublicKey {
        format!(
            "ed25519:{}",
            bs58::encode(self.sk.verifying_key().to_bytes()).into_string()
        )
        .parse()
        .unwrap()
    }
    fn attest(&self, contract: &str, route: &str, r: &ReportInput) -> AttestationInput {
        let msg = attestation::message(contract, route, r);
        AttestationInput {
            watcher_id: self.id.clone(),
            signature: Base64VecU8(self.sk.sign(msg.as_bytes()).to_bytes().to_vec()),
        }
    }
}

fn report(epoch: u64, status: Status, score: u8, reasons: &[&str], hash_byte: char) -> ReportInput {
    ReportInput {
        epoch,
        status,
        score,
        capacity_usd: default_capacity(status),
        reasons: reasons.iter().map(|s| s.to_string()).collect(),
        report_hash: hash_byte.to_string().repeat(64),
    }
}

/// Safe size used by the helper: blocked routes must sign 0.
fn default_capacity(status: Status) -> u64 {
    match status {
        Status::Green => 50_000,
        Status::Amber => 10_000,
        Status::Unknown | Status::Red => 0,
    }
}

/// Contract with three watchers, quorum 2, escalation 1.
fn setup() -> (Watchtower, Vec<Keyed>) {
    at(OWNER, EPOCH);
    let mut c = Watchtower::new(OWNER.parse().unwrap(), 1, None, None);
    let ws = vec![
        Keyed::new("w1.near", 1),
        Keyed::new("w2.near", 2),
        Keyed::new("w3.near", 3),
    ];
    for w in &ws {
        c.add_watcher(w.id.clone(), w.public_key());
    }
    c.set_quorum(2, Some(1));
    (c, ws)
}

#[test]
fn no_data_is_never_safe() {
    let (c, _) = setup();
    assert!(!c.is_safe(ROUTE.into(), None, None));
    assert_eq!(c.check_route(ROUTE.into(), None, None).verdict, "no_data");
}

#[test]
fn green_needs_quorum_across_separate_calls() {
    let (mut c, ws) = setup();
    let r = report(EPOCH, Status::Green, 100, &[], 'a');
    let out = c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &r)],
    );
    assert!(!out.applied);
    assert_eq!((out.votes, out.needed), (1, 2));
    assert!(!c.is_safe(ROUTE.into(), None, None));

    let out = c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![ws[1].attest(CONTRACT, ROUTE, &r)],
    );
    assert!(out.applied);
    assert!(c.is_safe(ROUTE.into(), None, None));
    let h = c.get_route_health(ROUTE.into()).unwrap();
    assert_eq!(h.signers, 2);
    assert!(get_logs()
        .iter()
        .any(|l| l.starts_with("EVENT_JSON:") && l.contains("route_health_updated")));
}

#[test]
fn relayer_can_submit_all_signatures_in_one_call() {
    let (mut c, ws) = setup();
    at("relayer.near", EPOCH);
    let r = report(EPOCH, Status::Green, 100, &[], 'b');
    let out = c.submit_report(
        ROUTE.into(),
        r.clone(),
        ws.iter().map(|w| w.attest(CONTRACT, ROUTE, &r)).collect(),
    );
    assert!(out.applied);
    assert_eq!(c.get_route_health(ROUTE.into()).unwrap().signers, 3);
}

#[test]
fn watchers_agree_on_the_verdict_not_on_every_byte() {
    // Watchers reading live chains seconds apart hash different inputs: same status, other hash.
    let (mut c, ws) = setup();
    let mut a = report(EPOCH, Status::Green, 100, &[], 'a');
    a.capacity_usd = 80_000;
    c.submit_report(
        ROUTE.into(),
        a.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &a)],
    );
    assert!(!c.is_safe(ROUTE.into(), None, None));
    at(OWNER, EPOCH + 1);
    let mut b = report(EPOCH + 1, Status::Green, 97, &[], 'b');
    b.capacity_usd = 50_000;
    let out = c.submit_report(
        ROUTE.into(),
        b.clone(),
        vec![ws[1].attest(CONTRACT, ROUTE, &b)],
    );
    assert!(out.applied);
    let h = c.get_route_health(ROUTE.into()).unwrap();
    // The most cautious of the two: lower score, smaller safe size, the older epoch.
    assert_eq!(
        (h.status, h.score, h.capacity_usd, h.epoch, h.signers),
        (Status::Green, 97, 50_000, EPOCH, 2)
    );
}

#[test]
fn fast_red_slow_green() {
    let (mut c, ws) = setup();
    let g = report(EPOCH, Status::Green, 100, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        g.clone(),
        vec![
            ws[0].attest(CONTRACT, ROUTE, &g),
            ws[1].attest(CONTRACT, ROUTE, &g),
        ],
    );

    // One watcher pulls the alarm.
    at(OWNER, EPOCH + 1);
    let red = report(
        EPOCH + 1,
        Status::Red,
        18,
        &["GHOST_CREDIT_WITHDRAWN:btc:bitcoin"],
        'c',
    );
    let out = c.submit_report(
        ROUTE.into(),
        red.clone(),
        vec![ws[2].attest(CONTRACT, ROUTE, &red)],
    );
    assert!(out.applied);
    assert!(!c.is_safe(ROUTE.into(), None, Some(true)));
    let chk = c.check_route(ROUTE.into(), None, None);
    assert_eq!(chk.verdict, "status");
    assert_eq!(
        chk.reasons,
        vec!["GHOST_CREDIT_WITHDRAWN:btc:bitcoin".to_string()]
    );

    // A single (possibly compromised) watcher cannot turn it green again.
    at(OWNER, EPOCH + 2);
    let g2 = report(EPOCH + 2, Status::Green, 100, &[], 'd');
    let out = c.submit_report(
        ROUTE.into(),
        g2.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &g2)],
    );
    assert!(!out.applied);
    assert_eq!(
        c.get_route_health(ROUTE.into()).unwrap().status,
        Status::Red
    );

    // ...nor soften red into unknown on its own.
    let u = report(
        EPOCH + 2,
        Status::Unknown,
        40,
        &["CUSTODY_DATA_STALE:btc:bitcoin"],
        'e',
    );
    assert!(
        !c.submit_report(
            ROUTE.into(),
            u.clone(),
            vec![ws[0].attest(CONTRACT, ROUTE, &u)]
        )
        .applied
    );

    // Two others saying green don't overrule an alarm its raiser still asserts...
    c.submit_report(
        ROUTE.into(),
        g2.clone(),
        vec![ws[1].attest(CONTRACT, ROUTE, &g2)],
    );
    assert_eq!(
        c.get_route_health(ROUTE.into()).unwrap().status,
        Status::Red
    );

    // ...but once it stands the alarm down, a quorum of green recovers the route. The watcher
    // that can't see (Unknown) doesn't block the two that can.
    at(OWNER, EPOCH + 3);
    let g3 = report(EPOCH + 3, Status::Green, 100, &[], 'f');
    let out = c.submit_report(
        ROUTE.into(),
        g3.clone(),
        vec![ws[2].attest(CONTRACT, ROUTE, &g3)],
    );
    assert!(out.applied);
    assert!(c.is_safe(ROUTE.into(), None, None));
    let h = c.get_route_health(ROUTE.into()).unwrap();
    assert_eq!(
        (h.status, h.signers, h.epoch),
        (Status::Green, 2, EPOCH + 2)
    );
}

#[test]
fn an_alarm_expires_when_its_raiser_goes_quiet() {
    let (mut c, ws) = setup();
    let red = report(EPOCH, Status::Red, 10, &["CHAIN_STALLED:bitcoin"], 'a');
    c.submit_report(
        ROUTE.into(),
        red.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &red)],
    );
    // Six minutes later the raiser hasn't repeated it; two watchers say green.
    at(OWNER, EPOCH + 6);
    let g = report(EPOCH + 6, Status::Green, 100, &[], 'b');
    c.submit_report(
        ROUTE.into(),
        g.clone(),
        vec![
            ws[1].attest(CONTRACT, ROUTE, &g),
            ws[2].attest(CONTRACT, ROUTE, &g),
        ],
    );
    assert!(c.is_safe(ROUTE.into(), None, None));
}

#[test]
fn single_watcher_cannot_keep_green_fresh() {
    let (mut c, ws) = setup();
    let g = report(EPOCH, Status::Green, 100, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        g.clone(),
        vec![
            ws[0].attest(CONTRACT, ROUTE, &g),
            ws[1].attest(CONTRACT, ROUTE, &g),
        ],
    );
    at(OWNER, EPOCH + 10);
    let g2 = report(EPOCH + 10, Status::Green, 100, &[], 'b');
    assert!(
        !c.submit_report(
            ROUTE.into(),
            g2.clone(),
            vec![ws[0].attest(CONTRACT, ROUTE, &g2)]
        )
        .applied
    );
    // The old green is now 10 minutes old: stale under the default 300s.
    assert!(!c.is_safe(ROUTE.into(), None, None));
    assert_eq!(c.check_route(ROUTE.into(), None, None).verdict, "stale");
    assert!(c.is_safe(ROUTE.into(), Some(900), None));
}

#[test]
fn late_cosigners_raise_the_signer_count() {
    let (mut c, ws) = setup();
    let red = report(EPOCH, Status::Red, 10, &["CHAIN_STALLED:bitcoin"], 'f');
    assert!(
        c.submit_report(
            ROUTE.into(),
            red.clone(),
            vec![ws[0].attest(CONTRACT, ROUTE, &red)]
        )
        .applied
    );
    assert_eq!(c.get_route_health(ROUTE.into()).unwrap().signers, 1);
    c.submit_report(
        ROUTE.into(),
        red.clone(),
        vec![ws[1].attest(CONTRACT, ROUTE, &red)],
    );
    assert_eq!(c.get_route_health(ROUTE.into()).unwrap().signers, 2);
}

#[test]
fn amber_is_opt_in() {
    let (mut c, ws) = setup();
    let a = report(
        EPOCH,
        Status::Amber,
        72,
        &["SOLVER_CONCENTRATED:btc:bitcoin->usdc:near"],
        'a',
    );
    c.submit_report(
        ROUTE.into(),
        a.clone(),
        vec![
            ws[0].attest(CONTRACT, ROUTE, &a),
            ws[1].attest(CONTRACT, ROUTE, &a),
        ],
    );
    assert!(!c.is_safe(ROUTE.into(), None, None));
    assert!(c.is_safe(ROUTE.into(), None, Some(true)));
}

#[test]
fn disagreement_is_visible_and_blocks_quorum() {
    let (mut c, ws) = setup();
    let a = report(EPOCH, Status::Green, 100, &[], 'a');
    let b = report(
        EPOCH,
        Status::Amber,
        70,
        &["SOLVER_CONCENTRATED:btc:bitcoin->usdc:near"],
        'b',
    );
    c.submit_report(
        ROUTE.into(),
        a.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &a)],
    );
    c.submit_report(
        ROUTE.into(),
        b.clone(),
        vec![ws[1].attest(CONTRACT, ROUTE, &b)],
    );
    assert_eq!(c.get_pending_rounds(ROUTE.into()).len(), 2);
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("watcher_disagreement")));
    // One watcher's caution is enough to hold the route at amber.
    assert_eq!(
        c.get_route_health(ROUTE.into()).unwrap().status,
        Status::Amber
    );
    assert!(!c.is_safe(ROUTE.into(), None, None));
}

#[test]
#[should_panic(expected = "invalid signature from w2.near")]
fn rejects_forged_signature() {
    let (mut c, ws) = setup();
    let r = report(EPOCH, Status::Green, 100, &[], 'a');
    let mut forged = ws[0].attest(CONTRACT, ROUTE, &r);
    forged.watcher_id = ws[1].id.clone();
    c.submit_report(ROUTE.into(), r, vec![forged]);
}

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_signature_made_for_another_contract() {
    let (mut c, ws) = setup();
    let r = report(EPOCH, Status::Red, 10, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![ws[0].attest("watchtower.testnet", ROUTE, &r)],
    );
}

#[test]
#[should_panic(expected = "invalid signature")]
fn rejects_signature_for_a_different_verdict() {
    let (mut c, ws) = setup();
    let signed = report(EPOCH, Status::Red, 10, &[], 'a');
    let att = ws[0].attest(CONTRACT, ROUTE, &signed);
    let tampered = report(EPOCH, Status::Green, 100, &[], 'a');
    c.submit_report(ROUTE.into(), tampered, vec![att]);
}

#[test]
#[should_panic(expected = "is not a registered watcher")]
fn rejects_unregistered_watcher() {
    let (mut c, _) = setup();
    let mallory = Keyed::new("mallory.near", 9);
    let r = report(EPOCH, Status::Red, 10, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![mallory.attest(CONTRACT, ROUTE, &r)],
    );
}

#[test]
#[should_panic(expected = "duplicate watcher")]
fn rejects_duplicate_signers() {
    let (mut c, ws) = setup();
    let r = report(EPOCH, Status::Green, 100, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![
            ws[0].attest(CONTRACT, ROUTE, &r),
            ws[0].attest(CONTRACT, ROUTE, &r),
        ],
    );
}

#[test]
#[should_panic(expected = "report is too old")]
fn rejects_stale_reports() {
    let (mut c, ws) = setup();
    at(OWNER, EPOCH + 30);
    let r = report(EPOCH, Status::Green, 100, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &r)],
    );
}

#[test]
#[should_panic(expected = "in the future")]
fn rejects_future_reports() {
    let (mut c, ws) = setup();
    let r = report(EPOCH + 5, Status::Red, 10, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &r)],
    );
}

#[test]
fn a_watcher_cannot_go_back_in_time() {
    let (mut c, ws) = setup();
    at(OWNER, EPOCH + 2);
    let r2 = report(EPOCH + 2, Status::Red, 10, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        r2.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &r2)],
    );
    // An older report from the same watcher (a replay, or a stuck relayer) changes nothing.
    let r1 = report(EPOCH + 1, Status::Green, 100, &[], 'b');
    c.submit_report(
        ROUTE.into(),
        r1.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &r1)],
    );
    let votes = c.get_pending_rounds(ROUTE.into());
    assert_eq!(
        (votes.len(), votes[0].epoch, votes[0].status),
        (1, EPOCH + 2, Status::Red)
    );
}

#[test]
#[should_panic(expected = "invalid route asset")]
fn validates_route_ids() {
    let (mut c, ws) = setup();
    let r = report(EPOCH, Status::Red, 10, &[], 'a');
    let bad = "BTC:bitcoin->usdc:near";
    c.submit_report(bad.into(), r.clone(), vec![ws[0].attest(CONTRACT, bad, &r)]);
}

#[test]
fn pause_and_overrides_only_ever_fail_closed() {
    let (mut c, ws) = setup();
    let g = report(EPOCH, Status::Green, 100, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        g.clone(),
        vec![
            ws[0].attest(CONTRACT, ROUTE, &g),
            ws[1].attest(CONTRACT, ROUTE, &g),
        ],
    );
    assert!(c.is_safe(ROUTE.into(), None, None));

    c.add_guardian("guardian.near".parse().unwrap());
    at("guardian.near", EPOCH);
    c.set_override(ROUTE.into(), Status::Red, "incident-42".into());
    assert_eq!(c.check_route(ROUTE.into(), None, None).verdict, "override");
    assert!(!c.is_safe(ROUTE.into(), None, Some(true)));
    c.pause();
    assert!(!c.is_safe("eth:ethereum->usdc:near".into(), None, None));

    at(OWNER, EPOCH);
    c.unpause();
    c.clear_override(ROUTE.into());
    assert!(c.is_safe(ROUTE.into(), None, None));
}

#[test]
#[should_panic(expected = "overrides can only make a route less safe")]
fn guardian_cannot_force_green() {
    let (mut c, _) = setup();
    c.set_override(ROUTE.into(), Status::Green, "nope".into());
}

#[test]
#[should_panic(expected = "guardian only")]
fn strangers_cannot_pause() {
    let (mut c, _) = setup();
    at("stranger.near", EPOCH);
    c.pause();
}

#[test]
fn safest_route_prefers_highest_safe_score() {
    let (mut c, ws) = setup();
    let routes = [
        "btc:bitcoin->usdc:near",
        "eth:ethereum->usdc:near",
        "sol:solana->usdc:near",
    ];
    let verdicts = [
        (Status::Green, 92u8, 'a'),
        (Status::Green, 100u8, 'b'),
        (Status::Red, 10u8, 'c'),
    ];
    for (route, (st, score, h)) in routes.iter().zip(verdicts) {
        let r = report(EPOCH, st, score, &[], h);
        c.submit_report(
            route.to_string(),
            r.clone(),
            vec![
                ws[0].attest(CONTRACT, route, &r),
                ws[1].attest(CONTRACT, route, &r),
            ],
        );
    }
    assert_eq!(
        c.safest_route(routes.iter().map(|r| r.to_string()).collect(), None, None),
        Some("eth:ethereum->usdc:near".to_string())
    );
    assert_eq!(
        c.safest_route(vec!["sol:solana->usdc:near".into()], None, None),
        None
    );
    assert_eq!(
        c.check_routes(routes.iter().map(|r| r.to_string()).collect(), None, None)
            .iter()
            .filter(|x| x.safe)
            .count(),
        2
    );
    assert_eq!(c.list_routes(None, Some(2)).len(), 2);
}

#[test]
fn safety_receipts_record_the_moment_and_charge_storage() {
    let (mut c, ws) = setup();
    let g = report(EPOCH, Status::Green, 100, &[], 'a');
    c.submit_report(
        ROUTE.into(),
        g.clone(),
        vec![
            ws[0].attest(CONTRACT, ROUTE, &g),
            ws[1].attest(CONTRACT, ROUTE, &g),
        ],
    );
    set_ctx(
        "agent.near",
        now_ms_for(EPOCH),
        NearToken::from_millinear(10),
    );
    let id = c.record_receipt(ROUTE.into(), "intent-hash-1".into(), None, None);
    let rc = c.get_receipt(id).unwrap();
    assert!(rc.safe);
    assert_eq!(rc.status, Some(Status::Green));
    assert_eq!(rc.report_hash.as_deref(), Some("a".repeat(64).as_str()));
    assert_eq!(rc.caller.as_str(), "agent.near");
    assert!(c.get_receipt(id + 1).is_none());
}

#[test]
#[should_panic(expected = "for receipt storage")]
fn receipts_require_a_storage_deposit() {
    let (mut c, _) = setup();
    at("agent.near", EPOCH);
    c.record_receipt(ROUTE.into(), "intent".into(), None, None);
}

#[test]
#[should_panic(expected = "quorum unreachable")]
fn cannot_remove_watchers_below_quorum() {
    let (mut c, ws) = setup();
    c.set_quorum(3, Some(1));
    c.remove_watcher(ws[0].id.clone());
}

// ----------------------------------------------------------------------------------------
// Cross-language vectors: signed by the TypeScript watcher, verified by this contract.
// ----------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Vectors {
    contract_id: String,
    watchers: Vec<VWatcher>,
    cases: Vec<VCase>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VWatcher {
    account_id: String,
    public_key: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VCase {
    name: String,
    route_id: String,
    report: VReport,
    message: String,
    attestations: Vec<VAtt>,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VReport {
    epoch: u64,
    status: Status,
    score: u8,
    capacity_usd: u64,
    reasons: Vec<String>,
    report_hash: String,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VAtt {
    watcher_id: String,
    signature: String,
}

#[test]
fn typescript_signed_vectors_verify_on_chain() {
    let v: Vectors =
        near_sdk::serde_json::from_str(include_str!("../../../test-vectors/attestation.json"))
            .unwrap();
    assert_eq!(v.contract_id, CONTRACT);
    at(OWNER, v.cases[0].report.epoch);
    let mut c = Watchtower::new(OWNER.parse().unwrap(), 1, None, None);
    for w in &v.watchers {
        c.add_watcher(w.account_id.parse().unwrap(), w.public_key.parse().unwrap());
    }
    c.set_quorum(2, Some(1));
    for case in v.cases {
        at("relayer.near", case.report.epoch);
        let r = ReportInput {
            epoch: case.report.epoch,
            status: case.report.status,
            score: case.report.score,
            capacity_usd: case.report.capacity_usd,
            reasons: case.report.reasons.clone(),
            report_hash: case.report.report_hash.clone(),
        };
        assert_eq!(
            c.attestation_message(case.route_id.clone(), r.clone()),
            case.message,
            "message mismatch in {}",
            case.name
        );
        let atts = case
            .attestations
            .iter()
            .map(|a| AttestationInput {
                watcher_id: a.watcher_id.parse().unwrap(),
                signature: Base64VecU8(
                    near_sdk::base64::Engine::decode(
                        &near_sdk::base64::engine::general_purpose::STANDARD,
                        &a.signature,
                    )
                    .unwrap(),
                ),
            })
            .collect();
        let out = c.submit_report(case.route_id.clone(), r, atts);
        assert!(
            out.applied,
            "vector {} did not apply (votes {} needed {})",
            case.name, out.votes, out.needed
        );
        assert_eq!(
            c.get_route_health(case.route_id.clone()).unwrap().status,
            case.report.status
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Safe size (v2): how much, not only whether
// ---------------------------------------------------------------------------------------------

#[test]
fn check_intent_enforces_the_signed_safe_size() {
    let (mut c, ws) = setup();
    let r = report(EPOCH, Status::Green, 92, &[], 'a');
    let atts = vec![
        ws[0].attest(CONTRACT, ROUTE, &r),
        ws[1].attest(CONTRACT, ROUTE, &r),
    ];
    at("relayer.near", EPOCH);
    assert!(c.submit_report(ROUTE.into(), r, atts).applied);

    let small = c.check_intent(ROUTE.into(), 20_000, None, None);
    assert!(small.allowed && small.safe);
    assert_eq!(small.verdict, "ok");
    assert_eq!(small.capacity_usd, Some(50_000));

    let exact = c.check_intent(ROUTE.into(), 50_000, None, None);
    assert!(exact.allowed, "the safe size itself is allowed");

    let big = c.check_intent(ROUTE.into(), 50_001, None, None);
    assert!(big.safe && !big.allowed);
    assert_eq!(big.verdict, "over_capacity");
}

#[test]
fn check_intent_is_fail_closed_like_is_safe() {
    let (mut c, ws) = setup();
    let none = c.check_intent(ROUTE.into(), 1, None, None);
    assert!(!none.allowed);
    assert_eq!(none.verdict, "no_data");

    let r = report(EPOCH, Status::Red, 5, &["GHOST_CREDIT:usdt"], 'b');
    at("relayer.near", EPOCH);
    c.submit_report(
        ROUTE.into(),
        r.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &r)],
    );
    let red = c.check_intent(ROUTE.into(), 0, None, None);
    assert!(!red.allowed, "even a zero amount is refused on a red route");
    assert_eq!(red.verdict, "status");
}

#[test]
#[should_panic(expected = "capacity_usd 0")]
fn red_verdicts_cannot_carry_a_safe_size() {
    let (mut c, ws) = setup();
    let mut r = report(EPOCH, Status::Red, 5, &[], 'c');
    r.capacity_usd = 1_000_000;
    let a = ws[0].attest(CONTRACT, ROUTE, &r);
    at("relayer.near", EPOCH);
    c.submit_report(ROUTE.into(), r, vec![a]);
}

#[test]
fn capacity_is_part_of_what_watchers_sign() {
    let (mut c, ws) = setup();
    let honest = report(EPOCH, Status::Green, 92, &[], 'd');
    let att = ws[0].attest(CONTRACT, ROUTE, &honest);
    let mut inflated = honest.clone();
    inflated.capacity_usd = 5_000_000;
    at("relayer.near", EPOCH);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_report(ROUTE.into(), inflated, vec![att]);
    }));
    assert!(
        res.is_err(),
        "a relayer must not be able to inflate the safe size"
    );
}

#[test]
fn batch_submits_a_whole_round_in_one_call() {
    let (mut c, ws) = setup();
    let other = "eth:ethereum->usdc:near";
    let a = report(EPOCH, Status::Green, 100, &[], 'a');
    let b = report(EPOCH, Status::Red, 5, &["GHOST_CREDIT"], 'b');
    let batch = |w: &Keyed| {
        vec![
            BatchReport {
                route_id: ROUTE.into(),
                report: a.clone(),
                attestations: vec![w.attest(CONTRACT, ROUTE, &a)],
            },
            BatchReport {
                route_id: other.into(),
                report: b.clone(),
                attestations: vec![w.attest(CONTRACT, other, &b)],
            },
        ]
    };
    let out = c.submit_reports(batch(&ws[0]));
    assert_eq!(out.len(), 2);
    // One signature: red is applied at once, green waits for a second watcher.
    assert!(!out[0].as_ref().unwrap().applied);
    assert!(out[1].as_ref().unwrap().applied);
    let out = c.submit_reports(batch(&ws[1]));
    assert!(out[0].as_ref().unwrap().applied);
    assert!(c.is_safe(ROUTE.into(), None, None));
    assert!(!c.is_safe(other.into(), None, None));
}

#[test]
fn batch_counts_a_slower_watchers_vote() {
    let (mut c, ws) = setup();
    at(OWNER, EPOCH + 1);
    let newer = report(EPOCH + 1, Status::Green, 100, &[], 'c');
    c.submit_report(
        ROUTE.into(),
        newer.clone(),
        vec![ws[0].attest(CONTRACT, ROUTE, &newer)],
    );
    // The second watcher's round started a minute earlier; its vote still makes the quorum.
    let older = report(EPOCH, Status::Green, 100, &[], 'd');
    let out = c.submit_reports(vec![BatchReport {
        route_id: ROUTE.into(),
        report: older.clone(),
        attestations: vec![ws[1].attest(CONTRACT, ROUTE, &older)],
    }]);
    assert!(out[0].as_ref().unwrap().applied);
    let h = c.get_route_health(ROUTE.into()).unwrap();
    assert_eq!((h.status, h.epoch), (Status::Green, EPOCH));
}

#[test]
#[should_panic(expected = "invalid signature")]
fn batch_still_rejects_forged_signatures() {
    let (mut c, ws) = setup();
    let r = report(EPOCH, Status::Green, 100, &[], 'a');
    let mut att = ws[0].attest(CONTRACT, ROUTE, &r);
    att.signature.0[0] ^= 1;
    c.submit_reports(vec![BatchReport {
        route_id: ROUTE.into(),
        report: r,
        attestations: vec![att],
    }]);
}

#[test]
#[should_panic(expected = "1..=32 reports per batch")]
fn batch_must_not_be_empty() {
    let (mut c, _) = setup();
    c.submit_reports(vec![]);
}
