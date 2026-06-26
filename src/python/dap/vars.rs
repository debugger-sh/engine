use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{json, Value};

/// One variable in a Python stack frame. The worker sends each frame's locals
/// fully expanded at pause time, so `children` already holds the entire subtree
/// (down to the worker's depth/node caps) — no lazy round-trips are needed.
#[derive(Debug, Clone, Deserialize)]
pub struct PythonVar {
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub children: Vec<PythonVar>,
    /// True when children are positional (list/tuple) rather than named
    /// (dict/object); controls the DAP `indexedVariables`/`namedVariables` hint.
    #[serde(default)]
    pub indexed: bool,
}

/// Per-stop table of Python variable handles. Each expandable node's children
/// are stored under a fresh `variablesReference` that the client resolves on a
/// follow-up `variables` request; the table is cleared on every new stop so
/// stale handles never resolve.
#[derive(Default)]
pub struct PythonVars {
    next_ref: i64,
    levels: HashMap<i64, Vec<PythonVar>>,
}

impl PythonVars {
    pub fn clear(&mut self) {
        self.next_ref = 0;
        self.levels.clear();
    }

    /// Store one level of variables and return its reference.
    pub fn allocate(&mut self, level: Vec<PythonVar>) -> i64 {
        self.next_ref += 1;
        self.levels.insert(self.next_ref, level);
        self.next_ref
    }

    /// Look up a previously stored level.
    pub fn get(&self, reference: i64) -> Option<&Vec<PythonVar>> {
        self.levels.get(&reference)
    }

    /// Render one node as a DAP `variable`, allocating a reference for its
    /// children when it has any (otherwise it's a leaf, reference 0).
    pub fn to_dap(&mut self, node: &PythonVar) -> Value {
        let mut out = json!({
            "name": node.name,
            "value": node.value,
            "variablesReference": 0,
        });

        if !node.children.is_empty() {
            let count = node.children.len();
            let reference = self.allocate(node.children.clone());
            let map = out.as_object_mut().expect("object literal");
            map.insert("variablesReference".into(), reference.into());
            let hint = if node.indexed { "indexedVariables" } else { "namedVariables" };
            map.insert(hint.into(), count.into());
        }

        out
    }
}
