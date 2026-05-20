//! `std::string` formatter.

use std::fmt::Write;
use std::ops::Range;

use anyhow::{Context, Result};

use crate::debug::formatters::{ChildCounts, VariableFormatter};
use crate::debug::{Type, Variable};

pub struct StdStringFormatter;

impl StdStringFormatter {
    fn read(value: &Variable) -> Result<Vec<u8>> {
        let dbg = value.debugger().context("no debugger")?;
        let rep = value.child_with_name("__rep_").context("__rep_")?;

        // __is_long_ / __size_ in __short are bitfields,
        let header = rep.read(12).context("read __rep_")?[11];

        if header & 0x80 == 0 {
            let len = (header & 0x7f) as usize;
            let buf = rep
                .child_with_name("__s")
                .and_then(|s| s.child_with_name("__data_"))
                .and_then(|d| d.address())
                .context("__s.__data_")?;
            return Ok(dbg.memory().read_memory(buf, len));
        }

        let l = rep.child_with_name("__l").context("__l")?;
        let data = l
            .child_with_name("__data_")
            .and_then(|d| d.pointer_value())
            .context("__l.__data_")?;
        let len = l
            .child_with_name("__size_")
            .and_then(|f| f.unsigned_value())
            .context("__l.__size_")? as usize;
        Ok(dbg.memory().read_memory(data, len))
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
