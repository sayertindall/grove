//! The summary cache: a finished answer stored under the sha256 of the exact
//! first request body that produced it. The same body again (same prompt, same
//! ambient snapshot, same model and settings) returns the stored answer without
//! contacting the provider. Local only, bounded, and off unless enabled.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::chat::{data_dir, read_json, write_json, ChatMessage};

pub const CACHE_FILE: &str = "chat-summary-cache.json";
/// Oldest entries are dropped past this many.
pub const CACHE_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedAnswer {
    key: String,
    message: ChatMessage,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CacheFile {
    #[serde(default)]
    entries: Vec<CachedAnswer>,
}

/// The cache key: sha256 over the serialized request body, hex.
pub fn request_key(body: &Value) -> String {
    let digest = Sha256::digest(body.to_string().as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The stored answer for `key`, if any.
pub fn lookup(key: &str) -> Option<ChatMessage> {
    let path = data_dir().ok()?.join(CACHE_FILE);
    read_json::<CacheFile>(&path)?
        .entries
        .into_iter()
        .rev()
        .find(|entry| entry.key == key)
        .map(|entry| entry.message)
}

/// Stores an answer under `key`, replacing an older one and keeping the newest
/// `CACHE_LIMIT`.
pub fn store(key: &str, message: &ChatMessage) -> Result<(), String> {
    let path = data_dir()?.join(CACHE_FILE);
    let mut entries = read_json::<CacheFile>(&path).unwrap_or_default().entries;
    entries.retain(|entry| entry.key != key);
    entries.push(CachedAnswer {
        key: key.to_string(),
        message: message.clone().for_webview(),
    });
    let excess = entries.len().saturating_sub(CACHE_LIMIT);
    entries.drain(..excess);
    write_json(&path, &CacheFile { entries })
}
