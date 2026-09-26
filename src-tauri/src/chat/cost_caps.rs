//! Token caps per turn, per app session, and per calendar month. The input side
//! is enforced by estimate (request bytes / 4) before anything is sent; the
//! output side by lowering `max_tokens` to what the caps still allow.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::chat::{data_dir, read_json, write_json};

/// Month totals, relative to the data directory.
pub const USAGE_FILE: &str = "chat-usage.json";

/// Tokens used since the app (or CLI) process started.
static SESSION_TOKENS: AtomicU64 = AtomicU64::new(0);

/// `None` means uncapped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CostCaps {
    pub per_turn_tokens: Option<u64>,
    pub per_session_tokens: Option<u64>,
    pub per_month_tokens: Option<u64>,
}

/// What has been spent, for the caps and the settings meter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    /// `YYYY-MM`, UTC.
    pub month: String,
    pub month_tokens: u64,
    #[serde(default)]
    pub session_tokens: u64,
}

/// Approximate tokens for a byte count: four bytes per token.
pub fn estimate_tokens(bytes: usize) -> u64 {
    (bytes as u64).div_ceil(4)
}

/// The current month's totals; a new month starts from zero.
pub fn load_usage() -> ChatUsage {
    let month = current_month();
    let stored = data_dir()
        .ok()
        .and_then(|dir| read_json::<ChatUsage>(&dir.join(USAGE_FILE)))
        .filter(|usage| usage.month == month);
    ChatUsage {
        month_tokens: stored.map_or(0, |usage| usage.month_tokens),
        month,
        session_tokens: SESSION_TOKENS.load(Ordering::Relaxed),
    }
}

/// Adds one request's tokens to the session and month totals.
pub fn record_usage(tokens: u64) -> Result<(), String> {
    SESSION_TOKENS.fetch_add(tokens, Ordering::Relaxed);
    let mut usage = load_usage();
    usage.month_tokens += tokens;
    write_json(&data_dir()?.join(USAGE_FILE), &usage)
}

/// Admits one request of `estimate` input tokens when every cap still has room,
/// and returns the `max_tokens` the answer may use. `turn_tokens` is what this
/// turn already spent on earlier steps.
pub fn admit_request(
    caps: &CostCaps,
    turn_tokens: u64,
    estimate: u64,
    max_tokens: u32,
) -> Result<u32, String> {
    let usage = load_usage();
    let limits = [
        ("per-turn", caps.per_turn_tokens, turn_tokens),
        ("per-session", caps.per_session_tokens, usage.session_tokens),
        ("monthly", caps.per_month_tokens, usage.month_tokens),
    ];
    let mut budget = u64::from(max_tokens);
    for (label, cap, used) in limits {
        let Some(cap) = cap else { continue };
        let room = cap.checked_sub(used + estimate).filter(|room| *room > 0);
        let room = room.ok_or_else(|| refusal(label, cap, used, estimate))?;
        budget = budget.min(room);
    }
    Ok(u32::try_from(budget).unwrap_or(max_tokens))
}

fn refusal(label: &str, cap: u64, used: u64, estimate: u64) -> String {
    format!(
        "cost cap: this request would send about {estimate} tokens with {used} already used, \
         leaving no room under the {label} cap of {cap} tokens. Nothing was sent. Raise the \
         cap in chat settings or ask a narrower question."
    )
}

/// `YYYY-MM` in UTC from the system clock (civil-from-days, no date crate).
fn current_month() -> String {
    let days = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() / 86_400)
        .unwrap_or(0) as i64;
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}")
}
