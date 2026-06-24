use serde_json::{json, Value};

use crate::dap::types::{PythonVar, VariablesMap};

fn is_dunder(name: &str) -> bool {
    name.starts_with("__") && name.ends_with("__")
}

pub fn filter_locals(locals: &[PythonVar]) -> Vec<PythonVar> {
    locals
        .iter()
        .filter(|v| !is_dunder(&v.name))
        .cloned()
        .collect()
}

pub fn python_var_to_dap(node: &PythonVar, vars: &mut VariablesMap) -> Value {
    let child_count = node.children.len();
    let sub_ref = if child_count == 0 {
        0
    } else {
        vars.allocate_python(node.children.clone())
    };

    let mut value = json!({
        "name": node.name,
        "value": node.value,
        "type": "",
        "variablesReference": sub_ref,
    });

    if child_count > 0 {
        if let Some(map) = value.as_object_mut() {
            map.insert("namedVariables".into(), child_count.into());
        }
    }

    value
}
