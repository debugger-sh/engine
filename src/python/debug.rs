use std::collections::HashMap;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;

const PYTHON_DEBUG_HEADER: u32 = 12;

#[derive(Debug, Clone, Deserialize)]
pub struct StackFrame {
    pub file: String,
    pub line: i64,
    pub function: String,
    pub locals: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PauseInfo {
    reason: String,
    frames: Vec<StackFrame>,
}

/// Main-thread Python debugger that operates on the shared memory buffer
/// sent from the worker via the `python_debug` message.
pub struct Debugger {
    control: js_sys::Int32Array,
    response: js_sys::Uint8Array,
    frames: Option<Vec<StackFrame>>,
    breakpoints: HashMap<String, Vec<i64>>,
}

impl Debugger {
    pub fn from_sab(sab: js_sys::SharedArrayBuffer) -> Self {
        Self {
            control: js_sys::Int32Array::new_with_byte_offset_and_length(&sab, 0, 3),
            response: js_sys::Uint8Array::new_with_byte_offset(&sab, PYTHON_DEBUG_HEADER),
            frames: None,
            breakpoints: HashMap::new(),
        }
    }

    pub fn on_pause(&mut self, json: &str) -> Result<&str> {
        let pause: PauseInfo = serde_json::from_str(json).context("parse Python pause JSON")?;
        self.frames = Some(pause.frames);
        Ok(match pause.reason.as_str() {
            "breakpoint" => "breakpoint",
            _ => "step",
        })
    }

    pub fn backtrace(&self) -> Result<&[StackFrame]> {
        self.frames
            .as_deref()
            .context("No Python frames")
    }

    pub fn locals(&self, frame_id: usize) -> Result<&HashMap<String, String>> {
        let frame = self
            .backtrace()?
            .get(frame_id)
            .context("Invalid frame id")?;
        Ok(&frame.locals)
    }

    pub fn set_breakpoints(&mut self, source: &str, lines: Vec<i64>) {
        self.breakpoints.insert(source.to_string(), lines);
    }

    pub fn continue_(&self) {
        self.send_command(0);
    }

    pub fn step_over(&self) {
        self.send_command(1);
    }

    pub fn step_into(&self) {
        self.send_command(2);
    }

    pub fn step_out(&self) {
        self.send_command(3);
    }

    fn send_command(&self, cmd: i32) {
        let json = json!({ "cmd": cmd, "breakpoints": self.breakpoints }).to_string();
        let bytes = json.as_bytes();
        let len = bytes.len().min(self.response.length() as usize) as u32;
        self.response
            .set(&js_sys::Uint8Array::from(&bytes[..len as usize]), 0);
        js_sys::Atomics::store(&self.control, 2, len as i32).expect("stored response length");
        js_sys::Atomics::store(&self.control, 1, cmd).expect("stored command");
        js_sys::Atomics::store(&self.control, 0, 1).expect("stored resume signal");
        js_sys::Atomics::notify(&self.control, 0).expect("notified python worker");
    }
}
