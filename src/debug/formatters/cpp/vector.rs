//! `std::vector` formatter.

use std::ops::Range;

use anyhow::{Context, Result, ensure};

use crate::debug::formatters::default::StructureFormatter;
use crate::debug::formatters::{ChildCounts, VariableFormatter};
use crate::debug::{Type, Variable};

pub struct StdVectorFormatter;

struct VectorData {
    begin: Variable,
    count: usize,
    elem_ty: Type,
    elem_size: usize,
}

impl StdVectorFormatter {
    fn data(value: &Variable) -> Result<VectorData> {
        // Since libc++ 23, the pointers are nested in `__layout_`, which (in the unstable ABI)
        // stores a `__size_` rather than an `__end_` pointer.
        let layout = value.child_with_name("__layout_");
        let value = layout.as_ref().unwrap_or(value);
        let begin = value
            .child_with_name("__begin_")
            .context("No child named '__begin_'")?;
        let begin_addr = begin
            .pointer_value()
            .context("std::vector __begin_ is unavailable")?;

        let elem_ty = begin
            .ty()
            .pointee()
            .context("std::vector element type is unavailable")?;
        let elem_size = elem_ty
            .byte_size()
            .context("std::vector element size is unavailable")? as usize;

        ensure!(elem_size > 0, "Invalid std::vector element size");
        let count = match value.child_with_name("__size_") {
            Some(size) => size
                .unsigned_value()
                .context("std::vector __size_ is unavailable")?,
            None => {
                let end = value
                    .child_with_name("__end_")
                    .and_then(|end| end.pointer_value())
                    .context("std::vector __end_ is unavailable")?;
                let bytes = u64::from(end)
                    .checked_sub(u64::from(begin_addr))
                    .context("std::vector end precedes begin")?;
                ensure!(bytes % elem_size as u64 == 0, "Invalid std::vector element range");
                bytes / elem_size as u64
            }
        };
        let memory_size = value.debugger().context("no debugger")?.memory().byte_size() as u64;
        ensure!(
            count
                .checked_mul(elem_size as u64)
                .and_then(|bytes| bytes.checked_add(u64::from(begin_addr)))
                .is_some_and(|end| end <= memory_size),
            "std::vector storage is outside memory"
        );
        ensure!(count == 0 || !begin_addr.is_null(), "std::vector storage is null");
        Ok(VectorData {
            begin: begin.clone(),
            count: count as usize,
            elem_ty,
            elem_size,
        })
    }
}

impl VariableFormatter for StdVectorFormatter {
    fn matches(&self, ty: &Type) -> bool {
        ty.matches("^std::vector<.+>$") && !ty.matches("^std::vector<bool[,>]")
    }

    fn display(&self, value: &Variable) -> Result<String> {
        StructureFormatter.display(value)
    }

    fn num_children(&self, value: &Variable) -> Result<ChildCounts> {
        let data = Self::data(value)?;
        Ok(ChildCounts::indexed(data.count))
    }

    fn indexed_children(&self, value: &Variable, range: Range<usize>) -> Result<Vec<Variable>> {
        let data = Self::data(value)?;
        let start = range.start.min(data.count);
        let end = range.end.min(data.count);
        ensure!(end.saturating_sub(start) <= 10_000, "std::vector page exceeds 10000 elements");

        let mut result = Vec::with_capacity(end.saturating_sub(start));
        for i in start..end {
            result.push(
                data.begin
                    .child_at_offset((i * data.elem_size) as isize)
                    .with_name(&format!("[{i}]"))
                    .with_type(&data.elem_ty),
            );
        }
        Ok(result)
    }

    fn named_children(&self, _value: &Variable, _range: Range<usize>) -> Result<Vec<Variable>> {
        Ok(Vec::new())
    }
}
