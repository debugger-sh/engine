use anyhow::{Context, Result};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use crate::dap::debugger::DapDebugger;
use crate::dap::types::{requested_range, VariableReference, VariablesMap};
use crate::python::debug::Debugger;

/// DAP backend for Python (Bdb bridge over a shared memory buffer).
pub struct PythonBackend {
    debugger: Debugger,
}

impl PythonBackend {
    pub fn new(debugger: Debugger) -> Self {
        Self { debugger }
    }
}

impl DapDebugger for PythonBackend {
    fn configuration_done(&mut self) -> Result<Value> {
        self.debugger.continue_();
        Ok(Value::Null)
    }

    fn set_breakpoints(&mut self, source: &str, lines: &[i64]) -> Result<Value> {
        self.debugger.set_breakpoints(source, lines.to_vec());
        let bps: Vec<_> = lines
            .iter()
            .map(|line| json!({ "verified": true, "line": line }))
            .collect();
        Ok(json!({ "breakpoints": bps }))
    }

    fn stack_trace(&self) -> Result<Value> {
        let frames = self.debugger.backtrace()?;
        let stack_frames: Vec<_> = frames
            .iter()
            .enumerate()
            .map(|(i, f)| {
                json!({
                    "id": i as i64,
                    "name": f.function,
                    "line": f.line,
                    "column": 0,
                    "source": { "path": f.file }
                })
            })
            .collect();
        Ok(json!({
            "stackFrames": stack_frames,
            "totalFrames": frames.len()
        }))
    }

    fn scopes(&mut self, args: &Value, vars: &mut VariablesMap) -> Result<Value> {
        let frame_id = args.get("frameId").and_then(|v| v.as_i64()).unwrap_or(0) as usize;
        let locals = self.debugger.locals(frame_id)?;
        let named_variables = locals.len();
        let entries: Vec<(String, String)> = locals
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let reference = vars.allocate_simple(entries);
        Ok(json!({
            "scopes": [{
                "name": "Locals",
                "variablesReference": reference,
                "expensive": false,
                "namedVariables": named_variables
            }]
        }))
    }

    fn variables(&mut self, args: &Value, vars: &mut VariablesMap) -> Result<Value> {
        let reference = args
            .get("variablesReference")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        let reference = vars
            .get(reference)
            .context("Unknown variablesReference")?
            .clone();

        let VariableReference::Simple(entries) = reference else {
            anyhow::bail!("Python variables are not expandable");
        };

        let range = requested_range(args, entries.len());
        let variables: Vec<_> = entries[range]
            .iter()
            .map(|(name, value)| {
                json!({
                    "name": name,
                    "value": value,
                    "type": "",
                    "variablesReference": 0
                })
            })
            .collect();
        Ok(json!({ "variables": variables }))
    }

    fn continue_(&mut self) -> Result<Value> {
        self.debugger.continue_();
        Ok(json!({ "allThreadsContinued": true }))
    }

    fn next(&mut self) -> Result<Value> {
        self.debugger.step_over();
        Ok(json!({}))
    }

    fn step_in(&mut self) -> Result<Value> {
        self.debugger.step_into();
        Ok(json!({}))
    }

    fn step_out(&mut self) -> Result<Value> {
        self.debugger.step_out();
        Ok(json!({}))
    }

    fn handle_paused(&mut self, msg: &JsValue) -> Result<Value> {
        let frame = js_sys::Reflect::get(msg, &"frame".into())
            .ok()
            .and_then(|v| v.as_string())
            .context("python paused message missing frame")?;
        let reason = self.debugger.on_pause(&frame)?;
        Ok(json!({
            "reason": reason,
            "threadId": 1,
            "allThreadsStopped": true,
        }))
    }
}
