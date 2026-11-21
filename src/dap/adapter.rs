use std::cell::RefCell;
use std::rc::Rc;

use serde::Serialize;
use serde_json::{Value, json};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::dap::session::DapSession;
use crate::dap::types::ProtocolMessage;
use crate::debug::Debugger;
use crate::debug::dap::DwarfBackend;
use crate::python::dap::adapter::PythonBackend;
use crate::python::debug::Debugger as PyDebugger;
use crate::types::DebugInfo;

#[wasm_bindgen]
pub struct DapAdapter {
    session: Rc<RefCell<DapSession>>,
    callback: Option<js_sys::Function>,
}

#[wasm_bindgen]
impl DapAdapter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            session: Rc::new(RefCell::new(DapSession::new())),
            callback: None,
        }
    }

    /// Receives a message from the process being debugged.
    ///
    /// A `debug` message (containing `DebugInfo`) constructs the internal debugger,
    /// `paused` messages emit DAP `stopped` events, and `stop` emits `terminated`.
    pub fn receive(&self, data: JsValue) {
        let session = &self.session;
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
                session
                    .borrow_mut()
                    .set_debugger(Box::new(DwarfBackend::new(Debugger::new(info))));
                session.borrow_mut().try_emit_initialized();
            }
            "python_debug" => {
                let send = js_sys::Reflect::get(&data, &"send".into())
                    .expect("python_debug message has send field")
                    .dyn_into::<js_sys::Function>()
                    .expect("send is a function");
                session
                    .borrow_mut()
                    .set_debugger(Box::new(PythonBackend::new(PyDebugger::new(send))));
                session.borrow_mut().try_emit_initialized();
            }
            "paused" => {
                let body = {
                    let mut s = session.borrow_mut();
                    let debugger = s.debugger_mut().expect("paused without debugger");
                    debugger.handle_paused(&data).expect("handle pause")
                };
                session.borrow_mut().emit_event("stopped", Some(body));
            }
            "stop" => {
                session
                    .borrow_mut()
                    .emit_event("terminated", Some(json!({ "restart": false })));
            }
            _ => {}
        }
        self.flush_events();
    }

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
        let response = self
            .session
            .borrow_mut()
            .process_request(seq, &command, &args);
        self.flush_events();

        let ser = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
        response.serialize(&ser).unwrap_or(JsValue::NULL)
    }

    pub fn on(&mut self, callback: js_sys::Function) {
        self.callback = Some(callback);
    }
}

impl DapAdapter {
    fn flush_events(&self) {
        let events = self.session.borrow_mut().take_events();
        let Some(callback) = &self.callback else {
            return;
        };
        for event in events {
            let _ = callback.call1(&JsValue::NULL, &event);
        }
    }
}
