use anyhow::Result;
use serde_json::Value;

use crate::dap::types::ProtocolMessage;

pub(crate) fn respond(rseq: i64, seq: i64, command: &str, result: Result<Value>) -> ProtocolMessage {
    match result {
        Ok(body) => ProtocolMessage::Response {
            seq: rseq,
            request_seq: seq,
            success: true,
            command: command.to_string(),
            message: None,
            body: if body.is_null() { None } else { Some(body) },
        },
        Err(e) => ProtocolMessage::Response {
            seq: rseq,
            request_seq: seq,
            success: false,
            command: command.to_string(),
            message: Some(e.to_string()),
            body: None,
        },
    }
}
