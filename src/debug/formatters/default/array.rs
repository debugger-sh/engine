use std::ops::Range;

use anyhow::{Context, Result, bail};

use crate::debug::formatters::default::StructureFormatter;
use crate::debug::formatters::{ChildCounts, VariableFormatter};
use crate::debug::{
    ArrayBound, ArrayUpperBound, DerivedEvaluationContext, TypeDeclaration, Variable, get_location,
};

pub struct ArrayFormatter;

impl VariableFormatter for ArrayFormatter {
    fn matches(&self, ty: &crate::debug::Type) -> bool {
        matches!(ty.resolved(), Some(TypeDeclaration::Array { .. }))
    }

    fn display(&self, value: &Variable) -> Result<String> {
        StructureFormatter.display(value)
    }

    fn num_children(&self, value: &Variable) -> Result<ChildCounts> {
        Ok(ChildCounts::indexed(element_count(value)?))
    }

    fn indexed_children(&self, value: &Variable, range: Range<usize>) -> Result<Vec<Variable>> {
        let ty = value.ty();
        let TypeDeclaration::Array { element_type, .. } = ty.resolved().context("array")? else {
            bail!("Cannot format non-array value");
        };

        let elem_ty = ty.child(*element_type);
        let elem_size = elem_ty.byte_size().context("element size")? as usize;
        let count = element_count(value)?;
        let start = range.start.min(count);
        let end = range.end.min(count);

        Ok((start..end)
            .map(|i| {
                value
                    .child_at_offset((i * elem_size) as isize)
                    .with_name(&format!("[{i}]"))
                    .with_type(&elem_ty)
            })
            .collect())
    }

    fn named_children(&self, _value: &Variable, _range: Range<usize>) -> Result<Vec<Variable>> {
        Ok(Vec::new())
    }
}

fn element_count(value: &Variable) -> Result<usize> {
    let TypeDeclaration::Array {
        lower_bound,
        upper_bound,
        ..
    } = value.ty().resolved().context("array")?
    else {
        bail!("array");
    };
    let count = match upper_bound {
        ArrayUpperBound::Count(b) => eval_bound(b, value)?,
        ArrayUpperBound::Index(b) => eval_bound(b, value)? - eval_bound(lower_bound, value)? + 1,
    };
    Ok(count.max(0) as usize)
}

fn eval_bound(bound: &ArrayBound, value: &Variable) -> Result<i64> {
    match bound {
        ArrayBound::Constant(c) => Ok(*c),
        ArrayBound::Expr(e) => value.context().evaluate_signed(e.clone()),
        ArrayBound::Ref(r) => {
            let ctx = value.context();
            let DerivedEvaluationContext { pc, .. } = ctx.derived()?;
            let var_die = r.deref(&value.debugger().context("debugger")?.info().dwarf)?;
            let ty = value.ty().child(var_die.type_ref().context("bound type")?);
            let loc = get_location(&var_die, pc).context("bound location")?;
            let v = Variable::new(ctx.clone(), String::new(), ctx.evaluate(loc)?, ty);
            return v.unsigned_value().map(|u| u as i64).context("bound");
        }
    }
}
