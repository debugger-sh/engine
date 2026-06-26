use serde::{Deserialize, Serialize};

/// Parse the `start`/`count` window of a DAP `variables` request, clamped to `len`.
pub(crate) fn requested_range(args: &serde_json::Value, len: usize) -> std::ops::Range<usize> {
    let start = usize_arg(args, "start").unwrap_or(0).min(len);
    let end = match usize_arg(args, "count") {
        Some(count) => start.saturating_add(count).min(len),
        None => len,
    };
    start..end
}

fn usize_arg(args: &serde_json::Value, name: &str) -> Option<usize> {
    args.get(name)
        .and_then(|v| v.as_u64())
        .and_then(|v| usize::try_from(v).ok())
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Base Protocol                                                            │
// ╰──────────────────────────────────────────────────────────────────────────╯

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProtocolMessage {
    #[serde(rename = "request")]
    Request {
        seq: i64,
        command: String,
        #[serde(default)]
        arguments: Option<serde_json::Value>,
    },
    #[serde(rename = "response")]
    Response {
        seq: i64,
        request_seq: i64,
        success: bool,
        command: String,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        body: Option<serde_json::Value>,
    },
    #[serde(rename = "event")]
    Event {
        seq: i64,
        event: String,
        #[serde(default)]
        body: Option<serde_json::Value>,
    },
}
