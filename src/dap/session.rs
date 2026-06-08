use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Value, json};

use crate::dap::debugger::DapDebugger;
use crate::dap::protocol::respond;
use crate::dap::types::{ProtocolMessage, VariablesMap};

/// Shared DAP protocol state. Language backends ([`DapDebugger`]) only supply response
/// bodies; this type owns sequence numbers, event emission, and response wrapping.
pub struct DapSession {
    seq_counter: i64,
    debugger: Option<Box<dyn DapDebugger>>,
    client_initialized: bool,
    initialized_emitted: bool,
    callback: Option<js_sys::Function>,
    vars: VariablesMap,
}

impl DapSession {
    pub fn new() -> Self {
        Self {
            seq_counter: 0,
            debugger: None,
            client_initialized: false,
            initialized_emitted: false,
            callback: None,
            vars: VariablesMap::default(),
        }
    }

    pub fn set_callback(&mut self, callback: js_sys::Function) {
        self.callback = Some(callback);
    }

    pub fn set_debugger(&mut self, debugger: Box<dyn DapDebugger>) {
        self.debugger = Some(debugger);
    }

    pub fn reset_run(&mut self) {
        self.debugger = None;
        self.initialized_emitted = false;
    }

    pub fn debugger_mut(&mut self) -> Option<&mut (dyn DapDebugger + '_)> {
        match self.debugger.as_mut() {
            Some(d) => Some(d.as_mut()),
            None => None,
        }
    }

    fn next_seq(&mut self) -> i64 {
        self.seq_counter += 1;
        self.seq_counter
    }

    /// Emit a DAP event with the next sequence number.
    pub fn emit_event(&mut self, event_name: &str, body: Option<Value>) {
        let seq = self.next_seq();
        let callback = self.callback.clone();

        if let Some(callback) = callback {
            let msg = ProtocolMessage::Event {
                seq,
                event: event_name.to_string(),
                body,
            };
            let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
            if let Ok(val) = msg.serialize(&ser) {
                let _ = callback.call1(&wasm_bindgen::JsValue::NULL, &val);
            }
        }
    }

    /// DAP: `InitializedEvent` after `initialize` was handled and a debugger is attached.
    pub fn try_emit_initialized(&mut self) {
        if self.client_initialized && self.debugger.is_some() && !self.initialized_emitted {
            self.initialized_emitted = true;
            self.emit_event("initialized", None);
        }
    }

    /// Handle one DAP request and return a fully-formed response (with sequence numbers).
    pub fn process_request(
        &mut self,
        request_seq: i64,
        command: &str,
        args: &Value,
    ) -> ProtocolMessage {
        let response_seq = self.next_seq();
        let result = match command {
            "initialize" => {
                self.client_initialized = true;
                self.handle_initialize()
            }
            "configurationDone" => self.handle_configuration_done(),
            "setExceptionBreakpoints" => self.handle_set_exception_breakpoints(),
            "setFunctionBreakpoints" => Ok(json!({ "breakpoints": [] })),
            "threads" => self.handle_threads(),
            "setBreakpoints" => self.handle_set_breakpoints(args),
            "stackTrace" => self.handle_stack_trace(),
            "scopes" => self.handle_scopes(args),
            "variables" => self.handle_variables(args),
            "continue" => self.handle_continue(),
            "next" => self.handle_next(),
            "stepIn" => self.handle_step_in(),
            "stepOut" => self.handle_step_out(),
            "disconnect" => Ok(Value::Null),
            other => Err(anyhow::anyhow!("Unknown command: {other}")),
        };

        let response = respond(response_seq, request_seq, command, result);

        if command == "initialize" {
            self.try_emit_initialized();
        }

        response
    }

    fn handle_initialize(&self) -> Result<Value> {
        Ok(json!({
            "supportsConfigurationDoneRequest": true,
            "supportsStepBack": false,
            "supportsFunctionBreakpoints": false,
        }))
    }

    fn handle_configuration_done(&mut self) -> Result<Value> {
        self.vars.clear();
        self.debugger
            .as_mut()
            .context("configurationDone: debugger not ready")?
            .configuration_done()
    }

    fn handle_set_exception_breakpoints(&self) -> Result<Value> {
        Ok(json!({ "breakpoints": [] }))
    }

    fn handle_threads(&self) -> Result<Value> {
        Ok(json!({
            "threads": [{ "id": 1, "name": "main" }]
        }))
    }

    fn handle_set_breakpoints(&mut self, args: &Value) -> Result<Value> {
        let source = args
            .get("source")
            .and_then(|s| s.get("path"))
            .and_then(|p| p.as_str())
            .unwrap_or("");
        let lines: Vec<i64> = args
            .get("breakpoints")
            .and_then(|b| b.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|bp| bp.get("line").and_then(|l| l.as_i64()))
                    .collect()
            })
            .unwrap_or_default();

        self.debugger
            .as_mut()
            .context("No debugger attached")?
            .set_breakpoints(source, &lines)
    }

    fn handle_stack_trace(&self) -> Result<Value> {
        self.debugger
            .as_ref()
            .context("No debugger attached")?
            .stack_trace()
    }

    fn handle_scopes(&mut self, args: &Value) -> Result<Value> {
        let vars = &mut self.vars;
        self.debugger
            .as_mut()
            .context("No debugger attached")?
            .scopes(args, vars)
    }

    fn handle_variables(&mut self, args: &Value) -> Result<Value> {
        let vars = &mut self.vars;
        self.debugger
            .as_mut()
            .context("No debugger attached")?
            .variables(args, vars)
    }

    fn handle_continue(&mut self) -> Result<Value> {
        self.vars.clear();
        self.debugger
            .as_mut()
            .context("No debugger attached")?
            .continue_()
    }

    fn handle_next(&mut self) -> Result<Value> {
        self.vars.clear();
        self.debugger
            .as_mut()
            .context("No debugger attached")?
            .next()
    }

    fn handle_step_in(&mut self) -> Result<Value> {
        self.vars.clear();
        self.debugger
            .as_mut()
            .context("No debugger attached")?
            .step_in()
    }

    fn handle_step_out(&mut self) -> Result<Value> {
        self.vars.clear();
        self.debugger
            .as_mut()
            .context("No debugger attached")?
            .step_out()
    }
}
