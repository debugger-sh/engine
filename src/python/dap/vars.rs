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

fn child_count_hint(value: &str) -> Option<(bool, i64)> {
    let (indexed, inner) = if let Some(inner) = value.strip_prefix("list[") {
        (true, inner)
    } else if let Some(inner) = value.strip_prefix("tuple[") {
        (true, inner)
    } else if let Some(inner) = value.strip_prefix("dict[") {
        (false, inner)
    } else if let Some((prefix, rest)) = value.split_once('[') {
        if matches!(prefix, "list" | "tuple" | "dict") {
            return None;
        }
        (false, rest)
    } else {
        return None;
    };
    let count = inner.strip_suffix(']')?.parse::<i64>().ok()?;
    Some((indexed, count))
}

pub fn python_var_to_dap(node: &PythonVar, vars: &mut VariablesMap) -> Value {
    let sub_ref = match node.object_ref {
        Some(worker_ref) => vars.allocate_python_lazy(worker_ref),
        None => 0,
    };

    let mut value = json!({
        "name": node.name,
        "value": node.value,
        "type": "",
        "variablesReference": sub_ref,
    });

    if let Some(map) = value.as_object_mut() {
        if let Some((indexed, count)) = child_count_hint(&node.value) {
            if indexed {
                map.insert("indexedVariables".into(), count.into());
            } else {
                map.insert("namedVariables".into(), count.into());
            }
        }
    }

    value
}
