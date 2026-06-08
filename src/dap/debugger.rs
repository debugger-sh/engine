use anyhow::Result;
use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::dap::types::VariablesMap;

/// Language-specific debugger backend for DAP.
///
/// Implementors only produce JSON **response bodies**. Sequence numbers, event emission,
/// and [`crate::dap::types::ProtocolMessage`] wrapping are handled by [`crate::dap::session::DapSession`].
pub trait DapDebugger {
    fn configuration_done(&mut self) -> Result<Value>;
    fn set_breakpoints(&mut self, source: &str, lines: &[i64]) -> Result<Value>;
    fn stack_trace(&self) -> Result<Value>;
    fn scopes(&mut self, args: &Value, vars: &mut VariablesMap) -> Result<Value>;
    fn variables(&mut self, args: &Value, vars: &mut VariablesMap) -> Result<Value>;
    fn continue_(&mut self) -> Result<Value>;
    fn next(&mut self) -> Result<Value>;
    fn step_in(&mut self) -> Result<Value>;
    fn step_out(&mut self) -> Result<Value>;
    /// Build the DAP `stopped` event body from the worker's raw `paused` message.
    /// Each backend reads only the fields its own worker emits.
    fn handle_paused(&mut self, msg: &JsValue) -> Result<Value>;
}
