use std::collections::HashMap;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::JsValue;

use crate::python::dap::vars::PythonVar;
use crate::util::weak_error;

// Resume commands sent to the worker. Must match the constants in bridge.py.
pub const PYTHON_CMD_CONTINUE: i32 = 0;
pub const PYTHON_CMD_STEP_OVER: i32 = 1;
pub const PYTHON_CMD_STEP_INTO: i32 = 2;
pub const PYTHON_CMD_STEP_OUT: i32 = 3;

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

/// Main-thread Python debugger, which sends commands to the bridge (`bridge.py`) as JSON
/// lines, through `send` (see `Debugger` in `src/ts/debugger.ts`).
pub struct Debugger {
    send: js_sys::Function,
    frames: Option<Vec<StackFrame>>,
    breakpoints: HashMap<String, Vec<i64>>,
}

impl Debugger {
    pub fn new(send: js_sys::Function) -> Self {
        Self { send, frames: None, breakpoints: HashMap::new() }
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
        self.send_resume(PYTHON_CMD_CONTINUE);
    }

    pub fn step_over(&self) {
        self.send_resume(PYTHON_CMD_STEP_OVER);
    }

    pub fn step_into(&self) {
        self.send_resume(PYTHON_CMD_STEP_INTO);
    }

    pub fn step_out(&self) {
        self.send_resume(PYTHON_CMD_STEP_OUT);
    }

    fn send_resume(&self, cmd: i32) {
        let line = format!("{}\n", json!({ "cmd": cmd, "breakpoints": self.breakpoints }));
        weak_error!(self.send.call1(&JsValue::NULL, &line.into()));
    }
}
