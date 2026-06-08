use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use wasm_bindgen::JsValue;

use crate::dap::debugger::DapDebugger;
use crate::dap::types::{requested_range, VariableReference, VariablesMap};
use crate::debug::formatters::ChildCounts;
use crate::debug::{Debugger, Variable};
use crate::types::PauseReason;
use crate::util::Ref;

/// DAP backend for DWARF-instrumented languages (C, C++, Rust, etc.).
pub struct DwarfBackend {
    debugger: Ref<Debugger>,
}

impl DwarfBackend {
    pub fn new(debugger: Ref<Debugger>) -> Self {
        Self { debugger }
    }

    fn scope_response(&self, name: &str, vars: Vec<Variable>, vars_map: &mut VariablesMap) -> Value {
        let nvars = vars.len();
        let reference = vars_map.allocate(vars);
        json!({
            "name": name,
            "variablesReference": reference,
            "expensive": false,
            "namedVariables": nvars
        })
    }

    fn variable_response(
        &self,
        var: &Variable,
        vars_map: &mut VariablesMap,
    ) -> Result<Value> {
        let counts = var.num_children().unwrap_or_default();
        let sub_ref = if counts.is_empty() {
            0
        } else {
            match vars_map.allocate_variable(var.clone(), counts.clone()) {
                Ok(r) => r,
                Err(_) => 0,
            }
        };

        let display = match var.display() {
            Ok(s) => s,
            Err(e) => format!("<error: {e}>"),
        };

        let mut value = json!({
            "name": var.name(),
            "value": display,
            "type": var.ty().name(),
            "variablesReference": sub_ref,
        });

        if let Some(map) = value.as_object_mut() {
            if counts.indexed > 0 {
                map.insert("indexedVariables".into(), counts.indexed.into());
            }
            if counts.named > 0 {
                map.insert("namedVariables".into(), counts.named.into());
            }
            if let Some(addr) = var.address() {
                map.insert("memoryReference".into(), addr.to_string().into());
            }
        }

        Ok(value)
    }
}

impl DapDebugger for DwarfBackend {
    fn configuration_done(&mut self) -> Result<Value> {
        self.debugger.continue_();
        Ok(Value::Null)
    }

    fn set_breakpoints(&mut self, source: &str, lines: &[i64]) -> Result<Value> {
        let bps: Vec<_> = lines
            .iter()
            .map(|line| {
                let location = self.debugger.set_breakpoint(source, *line);
                if let Some(location) = location {
                    json!({ "verified": true, "line": location.line })
                } else {
                    json!({ "verified": false })
                }
            })
            .collect();
        Ok(json!({ "breakpoints": bps }))
    }

    fn stack_trace(&self) -> Result<Value> {
        let frames = self
            .debugger
            .backtrace()
            .context("Failed to get backtrace")?;
        let total = frames.len();
        let stack_frames: Vec<_> = frames
            .iter()
            .map(|f| {
                let source = f.source.as_ref().map(|p| json!({ "path": p }));
                json!({
                    "id": f.id,
                    "name": f.name,
                    "line": f.line,
                    "column": f.column,
                    "source": source,
                })
            })
            .collect();
        Ok(json!({
            "stackFrames": stack_frames,
            "totalFrames": total,
        }))
    }

    fn scopes(&mut self, args: &Value, vars: &mut VariablesMap) -> Result<Value> {
        let frame_id = args.get("frameId").and_then(|v| v.as_i64()).unwrap_or(0) as u32;
        let variables = self.debugger.get_variables(frame_id)?;

        let mut scopes: Vec<Value> = Vec::new();
        if !variables.arguments.is_empty() {
            scopes.push(self.scope_response("Arguments", variables.arguments, vars));
        }
        if !variables.locals.is_empty() {
            scopes.push(self.scope_response("Locals", variables.locals, vars));
        }
        if !variables.globals.is_empty() {
            scopes.push(self.scope_response("Globals", variables.globals, vars));
        }

        Ok(json!({ "scopes": scopes }))
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

        let entries = requested_children(args, &reference)?;
        let variables: Result<Vec<_>> = entries
            .iter()
            .map(|var| self.variable_response(var, vars))
            .collect();
        Ok(json!({
            "variables": variables?
        }))
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
        let reason = js_sys::Reflect::get(msg, &"reason".into())
            .map_err(|_| anyhow!("paused message missing reason"))?;
        let reason: PauseReason = serde_wasm_bindgen::from_value(reason)
            .map_err(|e| anyhow!("PauseReason deserialization: {e}"))?;
        Ok(json!({
            "reason": match reason {
                PauseReason::Breakpoint => "breakpoint",
                PauseReason::Step => "step",
            },
            "threadId": 1,
            "allThreadsStopped": true,
        }))
    }
}

fn requested_children(args: &Value, reference: &VariableReference) -> Result<Vec<Variable>> {
    let filter = args.get("filter").and_then(|v| v.as_str());

    match reference {
        VariableReference::Simple(_) => Err(anyhow!("Simple variables are not expandable")),
        VariableReference::List(entries) => {
            let range = requested_range(args, entries.len());
            match filter {
                Some("indexed") => Ok(Vec::default()),
                Some("named") | None => Ok(entries[range].to_vec()),
                Some(filter) => Err(anyhow!("Invalid variable filter: '{:?}'", filter)),
            }
        }

        VariableReference::Variable { var, counts } => match filter {
            Some("indexed") => {
                let range = requested_range(args, counts.indexed);
                var.indexed_children(range)
            }
            Some("named") => {
                let range = requested_range(args, counts.named);
                var.named_children(range)
            }
            None => requested_mixed_children(args, var, counts),
            Some(filter) => Err(anyhow!("Invalid variable filter: '{:?}'", filter)),
        },
    }
}

fn requested_mixed_children(
    args: &Value,
    var: &Variable,
    counts: &ChildCounts,
) -> Result<Vec<Variable>> {
    let range = requested_range(args, counts.total());
    let named_start = range.start.min(counts.named);
    let named_end = range.end.min(counts.named);
    let indexed_start = range.start.saturating_sub(counts.named).min(counts.indexed);
    let indexed_end = range.end.saturating_sub(counts.named).min(counts.indexed);

    let mut children = var.named_children(named_start..named_end)?;
    children.extend(var.indexed_children(indexed_start..indexed_end)?);
    Ok(children)
}
