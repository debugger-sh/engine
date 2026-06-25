use serde_json::{json, Value};

use crate::dap::types::{PythonVar, VariablesMap};

/// Convert one Python variable node into a DAP `variable`. Children were already
/// expanded by the worker at pause time, so we only mint a `variablesReference`
/// (handing the children to `vars` for the next `variables` request) when there
/// are any — leaves get reference 0.
pub fn python_var_to_dap(node: &PythonVar, vars: &mut VariablesMap) -> Value {
    let mut out = json!({
        "name": node.name,
        "value": node.value,
        "variablesReference": 0,
    });

    if !node.children.is_empty() {
        let count = node.children.len();
        let reference = vars.allocate_python(node.children.clone());
        let map = out.as_object_mut().expect("object literal");
        map.insert("variablesReference".into(), reference.into());
        let hint = if node.indexed { "indexedVariables" } else { "namedVariables" };
        map.insert(hint.into(), count.into());
    }

    out
}
