use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

use crate::dap::types::{ProtocolMessage, VariableReference, VariablesMap};
use crate::debug::formatters::ChildCounts;
use crate::debug::{Debugger, Variable};
use crate::types::{DebugInfo, PauseReason};
use crate::util::Ref;

const PYTHON_DEBUG_HEADER: u32 = 12;

#[derive(Debug, Clone, Deserialize)]
struct PythonFrame {
    file: String,
    line: i64,
    function: String,
    locals: HashMap<String, String>,
}

struct PythonDebugState {
    control: js_sys::Int32Array,
    response: js_sys::Uint8Array,
    frames: Option<Vec<PythonFrame>>,
    breakpoints: HashMap<String, Vec<i64>>,
}

impl PythonDebugState {
    fn from_sab(sab: js_sys::SharedArrayBuffer) -> Self {
        Self {
            control: js_sys::Int32Array::new_with_byte_offset_and_length(&sab, 0, 3),
            response: js_sys::Uint8Array::new_with_byte_offset(&sab, PYTHON_DEBUG_HEADER),
            frames: None,
            breakpoints: HashMap::new(),
        }
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

struct DapState {
    seq_counter: i64,
    debugger: Option<Ref<Debugger>>,
    python_state: Option<PythonDebugState>,
    /// `initialize` request was handled and the client received the capabilities response.
    client_initialized: bool,
    /// We emitted `initialized` for this debug session (once per worker / run).
    initialized_emitted: bool,
    callback: Option<js_sys::Function>,
    vars: VariablesMap,
    _closure: Option<Closure<dyn FnMut(web_sys::MessageEvent)>>,
}

impl DapState {
    fn next_seq(&mut self) -> i64 {
        self.seq_counter += 1;
        self.seq_counter
    }

    fn debugger(&self) -> Option<&Debugger> {
        self.debugger.as_deref()
    }

    // Returns the capababilities. TODO: check what more we can support.
    fn handle_initialize(&self) -> Result<Value> {
        Ok(json!({
            "supportsConfigurationDoneRequest": true,
            "supportsStepBack": false,
            "supportsFunctionBreakpoints": false,
        }))
    }

    // interacts with wait_for_resume in the worker to unblock after config is done.
    fn handle_configuration_done(&mut self) -> Result<Value> {
        self.vars.clear();
        if let Some(py) = &self.python_state {
            py.send_command(0);
            return Ok(Value::Null);
        }
        self.debugger()
            .context("configurationDone: debugger not ready")?
            .continue_();
        Ok(Value::Null)
    }

    // We do not support exception breakpoints, but handle the request so we do not blow up.
    fn handle_set_exception_breakpoints(&self) -> Result<Value> {
        Ok(json!({ "breakpoints": [] }))
    }

    // WASM doesn't have threads in the traditional sense, so we report a single "main" thread. NOTE: we might extend later.
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

        if let Some(py) = &mut self.python_state {
            py.breakpoints.insert(source.to_string(), lines.clone());
            let bps: Vec<_> = lines
                .iter()
                .map(|line| json!({ "verified": true, "line": line }))
                .collect();
            return Ok(json!({ "breakpoints": bps }));
        }

        let dbg = self.debugger().context("No debugger attached")?;
        // TODO: set_breakpoints. once implemented, verify this handler does the right thing with the results (e.g. line numbers, verified status)
        let bps: Vec<_> = lines
            .iter()
            .map(|line| {
                let location = dbg.set_breakpoint(source, *line);
                if let Some(location) = location {
                    json!({ "verified": true, "line": location.line })
                } else {
                    json!({ "verified": false })
                }
            })
            .collect();
        Ok(json!({ "breakpoints": bps }))
    }

    fn handle_stack_trace(&self) -> Result<Value> {
        if let Some(py) = &self.python_state {
            let frames = py.frames.as_ref().context("No Python frames")?;
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
            return Ok(json!({
                "stackFrames": stack_frames,
                "totalFrames": frames.len()
            }));
        }

        let dbg = self.debugger().context("No debugger attached")?;
        let frames = dbg.backtrace().context("Failed to get backtrace")?;
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
                    // TODO: resolve later with jacob using DIE info from DWARF.
                    "source": source,
                })
            })
            .collect();
        Ok(json!({
            "stackFrames": stack_frames,
            "totalFrames": total,
        }))
    }

    fn handle_scopes(&mut self, args: &Value) -> Result<Value> {
        let frame_id = args.get("frameId").and_then(|v| v.as_i64()).unwrap_or(0) as usize;

        if let Some(py) = &mut self.python_state {
            let frames = py.frames.as_ref().context("No Python frames")?;
            let frame = frames.get(frame_id).context("Invalid frame id")?;
            let vars: Vec<(String, String)> = frame
                .locals
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            let reference = self.vars.allocate_simple(vars);
            return Ok(json!({
                "scopes": [{
                    "name": "Locals",
                    "variablesReference": reference,
                    "expensive": false,
                    "namedVariables": frame.locals.len()
                }]
            }));
        }

        let frame_id = frame_id as u32;
        let dbg = self.debugger().context("No debugger attached")?;
        let variables = dbg.get_variables(frame_id)?;

        let mut scopes: Vec<Value> = Vec::new();
        if !variables.arguments.is_empty() {
            scopes.push(self.scope_response("Arguments", variables.arguments));
        }
        if !variables.locals.is_empty() {
            scopes.push(self.scope_response("Locals", variables.locals));
        }
        if !variables.globals.is_empty() {
            scopes.push(self.scope_response("Globals", variables.globals));
        }

        Ok(json!({ "scopes": scopes }))
    }

    fn scope_response(&mut self, name: &str, vars: Vec<Variable>) -> Value {
        let nvars = vars.len();
        let reference = self.vars.allocate(vars);
        json!({
            "name": name,
            "variablesReference": reference,
            "expensive": false,
            "namedVariables": nvars
        })
    }

    fn handle_variables(&mut self, args: &Value) -> Result<Value> {
        let reference = args
            .get("variablesReference")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        // Snapshot the handle before allocating more handles below. Scope handles
        // already contain a small list of variables; expandable variable handles
        // keep only the parent variable so children can be fetched lazily.
        let reference = self
            .vars
            .get(reference)
            .context("Unknown variablesReference")?
            .clone();

        if let VariableReference::Simple(entries) = reference {
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
            return Ok(json!({ "variables": variables }));
        }

        let entries = requested_children(args, &reference)?;
        let variables: Result<Vec<_>> = entries
            .iter()
            .map(|var| self.variable_response(var))
            .collect();
        Ok(json!({
            "variables": variables?
        }))
    }

    fn variable_response(&mut self, var: &Variable) -> Result<Value> {
        // A formatter failure on one variable must not erase the whole locals
        // list — render the error inline and keep going.
        let counts = var.num_children().unwrap_or_default();
        let sub_ref = if counts.is_empty() {
            0
        } else {
            match self.vars.allocate_variable(var.clone(), counts.clone()) {
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

    fn handle_continue(&mut self) -> Result<Value> {
        self.vars.clear();
        if let Some(py) = &self.python_state {
            py.send_command(0);
            return Ok(json!({ "allThreadsContinued": true }));
        }
        if let Some(dbg) = self.debugger() {
            dbg.continue_();
        }
        Ok(json!({ "allThreadsContinued": true }))
    }

    fn handle_next(&mut self) -> Result<Value> {
        self.vars.clear();
        if let Some(py) = &self.python_state {
            py.send_command(1);
            return Ok(json!({}));
        }
        if let Some(dbg) = self.debugger() {
            dbg.step_over();
        }
        Ok(json!({}))
    }

    fn handle_step_in(&mut self) -> Result<Value> {
        self.vars.clear();
        if let Some(py) = &self.python_state {
            py.send_command(2);
            return Ok(json!({}));
        }
        if let Some(dbg) = self.debugger() {
            dbg.step_into();
        }
        Ok(json!({}))
    }

    fn handle_step_out(&mut self) -> Result<Value> {
        self.vars.clear();
        if let Some(py) = &self.python_state {
            py.send_command(3);
            return Ok(json!({}));
        }
        if let Some(dbg) = self.debugger() {
            dbg.step_out();
        }
        Ok(json!({}))
    }
}

/// Converts DAP's optional `start`/`count` pair into the range our formatter
/// interface expects. If `count` is absent, the client is asking for everything
/// from `start` to the end of this child group.
fn requested_range(args: &Value, len: usize) -> std::ops::Range<usize> {
    let start = usize_arg(args, "start").unwrap_or(0).min(len);
    let end = match usize_arg(args, "count") {
        Some(count) => start.saturating_add(count).min(len),
        None => len,
    };
    start..end
}

fn usize_arg(args: &Value, name: &str) -> Option<usize> {
    args.get(name)
        .and_then(|v| v.as_u64())
        .and_then(|v| usize::try_from(v).ok())
}

/// Fetches children for an expandable variable handle. DAP clients can request
/// only indexed children, only named children, or omit `filter` to get the mixed
/// view used by simple clients and tests.
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

/// Handles unfiltered child requests by treating named children as coming before
/// indexed children. This still respects `start`/`count`; without those fields,
/// the client has explicitly requested the full mixed child list.
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

fn respond(rseq: i64, seq: i64, command: &str, result: Result<Value>) -> ProtocolMessage {
    match result {
        Ok(body) => ProtocolMessage::Response {
            seq: rseq,
            request_seq: seq,
            success: true,
            command: command.to_string(),
            message: None,
            // DAP spec requires body to be omitted if null, so we convert it to an Option here.
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

/// Emits a DAP event to the registered callback (if any).
/// Borrows state briefly to read the callback, then drops the borrow before
/// invoking the callback so the callback can safely call back into the adapter.
fn emit_event(state: &Rc<RefCell<DapState>>, event_name: &str, body: Option<Value>) {
    let (callback, seq) = {
        let mut s = state.borrow_mut();
        let cb = s.callback.clone();
        let seq = s.next_seq();
        (cb, seq)
    };

    if let Some(callback) = callback {
        let msg = ProtocolMessage::Event {
            seq,
            event: event_name.to_string(),
            body,
        };
        let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        if let Ok(val) = msg.serialize(&ser) {
            let _ = callback.call1(&JsValue::NULL, &val);
        }
    }
}

/// DAP: `InitializedEvent` must be sent only after the `initialize` response was delivered,
/// and once the debug adapter is ready (C++ debugger or Python debug state from the worker).
fn try_emit_initialized(state: &Rc<RefCell<DapState>>) {
    let should = {
        let s = state.borrow();
        s.client_initialized
            && (s.debugger.is_some() || s.python_state.is_some())
            && !s.initialized_emitted
    };
    if should {
        state.borrow_mut().initialized_emitted = true;
        emit_event(state, "initialized", None);
    }
}

#[wasm_bindgen]
pub struct DapAdapter {
    state: Rc<RefCell<DapState>>,
}

#[wasm_bindgen]
impl DapAdapter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            state: Rc::new(RefCell::new(DapState {
                seq_counter: 0,
                debugger: None,
                python_state: None,
                client_initialized: false,
                initialized_emitted: false,
                callback: None,
                vars: VariablesMap::default(),
                _closure: None,
            })),
        }
    }

    /// Attaches a worker to the adapter.
    ///
    /// Listens for the worker's `debug` message (containing `DebugInfo`) to construct
    /// the internal `Debugger`, `breakpoint` messages to emit DAP `stopped` events,
    /// and `stop` messages to emit `terminated`.
    ///
    /// **Session flags:** we reset `initialized_emitted` so each worker/run can emit `initialized`
    /// again, but we **do not** clear `client_initialized`. Reasons:
    /// - The host may send `initialize` before `run()` attaches the worker; clearing here would
    ///   prevent `initialized` from ever firing on the subsequent `debug` message.
    /// - On **re-run** (same adapter instance, new worker), the client often does **not** send
    ///   `initialize` again. Keeping `client_initialized` true means the next `debug` message can
    ///   emit `initialized` immediately without waiting for another `initialize` request. That is
    /// intentional for this embedding. A client that wants a strict fresh DAP session per run
    /// should send `initialize` again (and/or construct a new engine so the adapter is new).
    pub fn attach(&self, worker: web_sys::Worker) {
        {
            let mut s = self.state.borrow_mut();
            s.debugger = None;
            s.python_state = None;
            s.initialized_emitted = false;
        }

        let state = self.state.clone();

        let closure = Closure::wrap(Box::new(move |event: web_sys::MessageEvent| {
            let data = event.data();
            let msg_type = js_sys::Reflect::get(&data, &"type".into())
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_default();

            match msg_type.as_str() {
                "debug" => {
                    let info = js_sys::Reflect::get(&data, &"info".into())
                        .expect("debug message has info field");
                    let info: DebugInfo =
                        serde_wasm_bindgen::from_value(info).expect("DebugInfo deserialization");
                    state.borrow_mut().debugger = Some(Debugger::new(info));
                    try_emit_initialized(&state);
                }
                "python_debug" => {
                    let sab = js_sys::Reflect::get(&data, &"state".into())
                        .expect("python_debug message has state field");
                    let sab = sab
                        .dyn_into::<js_sys::SharedArrayBuffer>()
                        .expect("state is a SharedArrayBuffer");
                    state.borrow_mut().python_state = Some(PythonDebugState::from_sab(sab));
                    try_emit_initialized(&state);
                }
                "paused" => {
                    let frame_json = js_sys::Reflect::get(&data, &"frame".into())
                        .ok()
                        .and_then(|v| v.as_string());

                    if let Some(json_str) = frame_json {
                        let frames: Vec<PythonFrame> =
                            serde_json::from_str(&json_str).expect("parse Python frame JSON");
                        {
                            let mut s = state.borrow_mut();
                            if let Some(py) = &mut s.python_state {
                                py.frames = Some(frames);
                            }
                        }
                        emit_event(
                            &state,
                            "stopped",
                            Some(json!({
                                "reason": "step",
                                "threadId": 1,
                                "allThreadsStopped": true,
                            })),
                        );
                    } else {
                        let reason = js_sys::Reflect::get(&data, &"reason".into())
                            .expect("paused message has reason field");
                        let reason: PauseReason = serde_wasm_bindgen::from_value(reason)
                            .expect("PauseReason deserialization");
                        emit_event(
                            &state,
                            "stopped",
                            Some(json!({
                                "reason": match reason {
                                    PauseReason::Breakpoint => "breakpoint",
                                    PauseReason::Step => "step"
                                },
                                "threadId": 1,
                                "allThreadsStopped": true,
                            })),
                        );
                    }
                }
                "stop" => {
                    emit_event(&state, "terminated", Some(json!({ "restart": false })));
                }
                _ => {}
            }
        }) as Box<dyn FnMut(web_sys::MessageEvent)>);

        worker
            .add_event_listener_with_callback("message", closure.as_ref().unchecked_ref())
            .expect("Added message listener to worker");

        self.state.borrow_mut()._closure = Some(closure);
    }

    /// Sends a DAP request and returns the response synchronously.
    /// Events are emitted separately through the registered callback.
    #[wasm_bindgen(js_name = "sendMessage")]
    pub fn send_message(&self, msg: JsValue) -> JsValue {
        let request: ProtocolMessage = match serde_wasm_bindgen::from_value(msg) {
            Ok(r) => r,
            Err(_) => return JsValue::NULL,
        };

        let ProtocolMessage::Request {
            seq,
            command,
            arguments,
        } = request
        else {
            return JsValue::NULL;
        };

        let args = arguments.unwrap_or(Value::Null);

        let (rseq, result) = {
            let mut state = self.state.borrow_mut();
            let rseq = state.next_seq();
            let result = match command.as_str() {
                "initialize" => {
                    state.client_initialized = true;
                    state.handle_initialize()
                }
                "configurationDone" => state.handle_configuration_done(),
                "setExceptionBreakpoints" => state.handle_set_exception_breakpoints(),
                "setFunctionBreakpoints" => Ok(json!({ "breakpoints": [] })),
                "threads" => state.handle_threads(),
                "setBreakpoints" => state.handle_set_breakpoints(&args),
                "stackTrace" => state.handle_stack_trace(),
                "scopes" => state.handle_scopes(&args),
                "variables" => state.handle_variables(&args),
                "continue" => state.handle_continue(),
                "next" => state.handle_next(),
                "stepIn" => state.handle_step_in(),
                "stepOut" => state.handle_step_out(),
                "disconnect" => Ok(Value::Null),
                other => Err(anyhow::anyhow!("Unknown command: {other}")),
            };
            (rseq, result)
        }; // borrow_mut dropped here

        let response = respond(rseq, seq, &command, result);
        let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        let out = response.serialize(&ser).unwrap_or(JsValue::NULL);

        if command == "initialize" {
            try_emit_initialized(&self.state);
        }

        out
    }

    /// Registers a callback that receives all DAP events.
    pub fn on(&self, callback: js_sys::Function) {
        self.state.borrow_mut().callback = Some(callback);
    }
}
