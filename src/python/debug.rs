use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::dap::types::PythonVar;

pub const PYTHON_DEBUG_HEADER: u32 = 12;
pub const PYTHON_RESPONSE_MAX: usize = 4096 - PYTHON_DEBUG_HEADER as usize;

pub const PYTHON_CMD_CONTINUE: i32 = 0;

pub const SIGNAL_IDLE: i32 = 0;
pub const SIGNAL_MAIN_CMD: i32 = 1;

#[derive(Debug, Clone, Deserialize)]
pub struct StackFrame {
    pub file: String,
    pub line: i64,
    pub function: String,
    pub user: bool,
    pub locals: Vec<PythonVar>,
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

    pub fn locals(&self, frame_id: usize) -> Result<&[PythonVar]> {
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
        let _ = self.send_resume(PYTHON_CMD_CONTINUE);
    }

    pub fn step_over(&self) {
        let _ = self.send_resume(1);
    }

    pub fn step_into(&self) {
        let _ = self.send_resume(2);
    }

    pub fn step_out(&self) {
        let _ = self.send_resume(3);
    }

    fn send_resume(&self, cmd: i32) -> Result<()> {
        let payload = json!({ "cmd": cmd, "breakpoints": self.breakpoints });
        self.send_request(&payload)
    }

    fn send_request(&self, payload: &Value) -> Result<()> {
        let bytes = payload.to_string().into_bytes();
        if bytes.len() > PYTHON_RESPONSE_MAX {
            bail!(
                "Python debug request exceeds SAB ({} bytes, max {})",
                bytes.len(),
                PYTHON_RESPONSE_MAX
            );
        }

        self.response
            .set(&js_sys::Uint8Array::from(&bytes[..]), 0);
        js_sys::Atomics::store(&self.control, 2, bytes.len() as i32)
            .expect("stored request length");
        js_sys::Atomics::store(&self.control, 1, payload["cmd"].as_i64().unwrap_or(0) as i32)
            .expect("stored command");
        js_sys::Atomics::store(&self.control, 0, SIGNAL_MAIN_CMD).expect("stored main command");
        js_sys::Atomics::notify(&self.control, 0).expect("notified python worker");
        Ok(())
    }
}
