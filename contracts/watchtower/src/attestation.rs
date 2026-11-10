//! Attestation format shared with the TypeScript watchers (packages/core/src/attest.ts).
//!
//! A watcher signs exactly one UTF-8 line:
//!
//! ```text
//! iwt:v2|<contract_id>|<route_id>|<epoch>|<status>|<score>|<capacity_usd>|<reasons,comma,joined>|<report_hash>
//! ```
//!
//! Binding the contract id, route, epoch and the full verdict means a signature can be relayed
//! by anyone but can never be replayed onto another contract, route, time or verdict.

use crate::types::ReportInput;
use near_sdk::{env, require, CurveType, PublicKey};

pub const DOMAIN: &str = "iwt:v2";
pub const MAX_REASONS: usize = 16;
pub const MAX_ROUTE_LEN: usize = 128;

pub fn message(contract_id: &str, route_id: &str, r: &ReportInput) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        DOMAIN,
        contract_id,
        route_id,
        r.epoch,
        r.status.as_str(),
        r.score,
        r.capacity_usd,
        r.reasons.join(","),
        r.report_hash
    )
}

pub fn verify(public_key: &PublicKey, signature: &[u8], msg: &str) -> bool {
    if public_key.curve_type() != CurveType::ED25519 {
        return false;
    }
    // as_bytes() = [curve_type, key bytes...]
    let pk: [u8; 32] = match public_key.as_bytes()[1..].try_into() {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig: [u8; 64] = match signature.try_into() {
        Ok(s) => s,
        Err(_) => return false,
    };
    env::ed25519_verify(&sig, msg.as_bytes(), &pk)
}

fn is_part(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 32
        && s.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && (b == b'_' || b == b'.' || b == b'-'))
        })
}

/// "src_symbol:src_chain->dst_symbol:dst_chain", lowercase, same rules as the TS `isValidRouteId`.
pub fn assert_valid_route(route_id: &str) {
    require!(route_id.len() <= MAX_ROUTE_LEN, "route_id too long");
    let sides: Vec<&str> = route_id.split("->").collect();
    require!(
        sides.len() == 2,
        "route_id must be 'symbol:chain->symbol:chain'"
    );
    require!(
        sides[0] != sides[1],
        "route source and destination must differ"
    );
    for side in sides {
        let parts: Vec<&str> = side.split(':').collect();
        require!(
            parts.len() == 2 && is_part(parts[0]) && is_part(parts[1]),
            "invalid route asset"
        );
    }
}

pub fn assert_valid_report(r: &ReportInput) {
    require!(r.score <= 100, "score must be 0..=100");
    if matches!(
        r.status,
        crate::types::Status::Red | crate::types::Status::Unknown
    ) {
        require!(
            r.capacity_usd == 0,
            "unsafe or unverified verdicts must have capacity_usd 0"
        );
    }
    require!(
        r.report_hash.len() == 64
            && r.report_hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "report_hash must be 64 lowercase hex chars"
    );
    require!(r.reasons.len() <= MAX_REASONS, "too many reasons");
    for reason in &r.reasons {
        let (code, subject) = match reason.split_once(':') {
            Some((c, s)) => (c, Some(s)),
            None => (reason.as_str(), None),
        };
        require!(
            !code.is_empty()
                && code.len() <= 40
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
            "invalid reason code"
        );
        if let Some(s) = subject {
            require!(
                !s.is_empty()
                    && s.len() <= 80
                    && s.bytes().all(|b| b.is_ascii_lowercase()
                        || b.is_ascii_digit()
                        || b"_.:->".contains(&b)),
                "invalid reason subject"
            );
        }
    }
}
