//! `std::string` formatter.

use std::fmt::Write;
use std::ops::Range;

use anyhow::{Context, Result};

use crate::debug::formatters::{ChildCounts, VariableFormatter};
use crate::debug::{Type, Variable};
use crate::types::GlobalAddress;

pub struct StdStringFormatter;

impl StdStringFormatter {
    /// Decodes the libc++ `std::string` SSO union into the raw character bytes.
    //
    // On wasm32 the union is 12 bytes. The high bit of the last byte is
    // `__is_long_`; we decode it from the raw layout because bitfields aren't
    // yet surfaced by the type graph.
    //   short: bytes[..len] hold the chars; low 7 bits of byte 11 = len
    //   long:  ptr u32, size u32, cap u32 (top bit of cap is __is_long_)
    fn read(value: &Variable) -> Result<Vec<u8>> {
        let bytes = value.read(12).context("read std::string rep")?;
        if bytes[11] & 0x80 == 0 {
            let len = (bytes[11] & 0x7f) as usize;
            return Ok(bytes[..len].to_vec());
        }
        let addr = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let len = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let dbg = value.debugger().context("no debugger")?;
        Ok(dbg.memory().read_memory(GlobalAddress::from(addr), len))
    }
}

fn quote(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() + 2);
    s.push('"');
    for &b in bytes {
        match b {
            b'"' => s.push_str("\\\""),
            b'\\' => s.push_str("\\\\"),
            b'\n' => s.push_str("\\n"),
            b'\r' => s.push_str("\\r"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(b as char),
            _ => write!(s, "\\x{b:02x}").unwrap(),
        }
    }
    s.push('"');
    s
}

impl VariableFormatter for StdStringFormatter {
    fn matches(&self, ty: &Type) -> bool {
        let name = ty.name();
        ty.ns().matches("std") && name.starts_with("std::string")
    }

    fn display(&self, value: &Variable) -> Result<String> {
        Ok(quote(&Self::read(value)?))
    }

    fn num_children(&self, _value: &Variable) -> Result<ChildCounts> {
        Ok(ChildCounts::default())
    }

    fn indexed_children(&self, _value: &Variable, _range: Range<usize>) -> Result<Vec<Variable>> {
        Ok(Vec::new())
    }

    fn named_children(&self, _value: &Variable, _range: Range<usize>) -> Result<Vec<Variable>> {
        Ok(Vec::new())
    }
}
