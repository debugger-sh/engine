//! `std::string` formatter.

use std::ops::Range;

use anyhow::Result;

use crate::debug::formatters::{ChildCounts, VariableFormatter};
use crate::debug::{Type, Variable};

pub struct StdStringFormatter;

impl StdStringFormatter {
    fn read(value: &Variable) -> Result<Vec<u8>> {
        // libc++ __rep is a 12-byte union (wasm32). The high bit of the last
        // byte is __is_long_; bitfields aren't yet surfaced by the type graph,
        // so decode the layout directly from the raw bytes.
        let bytes = value.read(12).context("read string rep")?;
        if bytes[11] & 0x80 == 0 {
            let len = (bytes[11] & 0x7f) as usize;
            Ok(bytes[..len].to_vec())
        } else {
            let addr = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as u64;
            let len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
            let dbg = value.debugger().context("no debugger")?;
            Ok(read_main_memory(dbg.info(), addr, len))
        }
    }
}

impl VariableFormatter for StdStringFormatter {
    fn matches(&self, ty: &Type) -> bool {
        let name = ty.name();
        ty.ns().matches("std") && (name == "std::string" || name.starts_with("std::string"))
    }

    fn display(&self, _value: &Variable) -> Result<String> {
        anyhow::bail!("not implemented")
    }

    fn num_children(&self, _value: &Variable) -> Result<ChildCounts> {
        anyhow::bail!("not implemented")
    }

    fn indexed_children(&self, _value: &Variable, _range: Range<usize>) -> Result<Vec<Variable>> {
        anyhow::bail!("not implemented")
    }

    fn named_children(&self, _value: &Variable, _range: Range<usize>) -> Result<Vec<Variable>> {
        anyhow::bail!("not implemented")
    }
}
