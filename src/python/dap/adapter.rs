use anyhow::{Context, Result};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use crate::dap::debugger::DapDebugger;
use crate::dap::types::{requested_range, VariableReference, VariablesMap};
use crate::python::dap::vars::python_var_to_dap;
use crate::python::debug::Debugger;

/// DAP backend for Python (Bdb bridge over a shared memory buffer).
pub struct PythonBackend {
    debugger: Debugger,
    /// When true, internal frames (bdb, bridge) are omitted from `stackTrace` responses.
    /// Internal frames are always tagged with `presentationHint: "subtle"` regardless.
    filter_internals: bool,
}

impl PythonBackend {
    pub fn new(debugger: Debugger, filter_internals: bool) -> Self {
        Self { debugger, filter_internals }
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
            .filter(|(_, f)| !self.filter_internals || f.user)
            .map(|(i, f)| {
                json!({
                    "id": i as i64,
                    "name": f.function,
                    "line": f.line,
                    "column": 0,
                    "source": { "path": f.file },
                    "presentationHint": if f.user { "normal" } else { "subtle" }
                })
            })
            .collect();
        let total = stack_frames.len();
        Ok(json!({
            "stackFrames": stack_frames,
            "totalFrames": total
        }))
    }

    fn scopes(&mut self, args: &Value, vars: &mut VariablesMap) -> Result<Value> {
        let frame_id = args.get("frameId").and_then(|v| v.as_i64()).unwrap_or(0) as usize;
        let locals = self.debugger.locals(frame_id)?.to_vec();
        let named_variables = locals.len();
        let reference = vars.allocate_python(locals);
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

        let VariableReference::Python(nodes) = reference else {
            anyhow::bail!("Python variablesReference is not expandable");
        };

        let range = requested_range(args, nodes.len());
        let variables: Vec<Value> = nodes[range]
            .iter()
            .map(|node| python_var_to_dap(node, vars))
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
