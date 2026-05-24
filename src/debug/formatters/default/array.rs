use std::ops::Range;

use anyhow::Result;

use crate::debug::formatters::default::StructureFormatter;
use crate::debug::formatters::{ChildCounts, VariableFormatter};
use crate::debug::{MemberLocation, Type, TypeDeclaration, Variable};

pub struct ArrayFormatter;

impl VariableFormatter for ArrayFormatter {
    fn matches(&self, ty: &Type) -> bool {
        matches!(ty.resolved(), Some(TypeDeclaration::Array { .. }))
    }

    fn display(&self, value: &Variable) -> Result<String> {
        StructureFormatter.display(value)
    }

    fn num_children(&self, value: &Variable) -> Result<ChildCounts> {
        Ok(ChildCounts::none())
    }

    fn indexed_children(&self, _value: &Variable, _range: Range<usize>) -> Result<Vec<Variable>> {
        Ok(Vec::new())
    }

    fn named_children(&self, value: &Variable, range: Range<usize>) -> Result<Vec<Variable>> {
        Ok(Vec::new())
    }
}
