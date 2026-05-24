use anyhow::{Context, Result};

use crate::{
    debug::{
        Debugger, EvaluationContext,
        dwarf::{Die, DieReference, Dwarf, R, Visit},
        formatters::VariableFormatter,
    },
    util::{Ref, WeakRef, weak_error},
};

use std::{cell::RefCell, collections::HashMap, rc::Rc};

pub type TypeId = DieReference;

#[derive(Clone, Debug, Default)]
pub struct NamespaceHierarchy(pub Vec<String>);

impl NamespaceHierarchy {
    pub fn qualify(&self, name: &str) -> String {
        let qualified = if self.0.is_empty() {
            name.to_string()
        } else {
            format!("{}::{name}", self.0.join("::"))
        };

        // Note: qualified `std` library names have the inline marker `std::__2`.
        // TODO: This is a hack, we should really parse out all template parameters
        qualified.replace("std::__2::", "std::")
    }
}

#[derive(Clone)]
pub struct Type {
    root: TypeId,
    graph: WeakRef<TypeGraph>,
}

pub struct TypeGraph {
    me: WeakRef<Self>,
    debugger: WeakRef<Debugger>,
    types: HashMap<TypeId, TypeDeclaration>,

    /// Cached computations of the formatter for a given type.
    formatters: RefCell<HashMap<TypeId, Option<Rc<dyn VariableFormatter>>>>,
}

/// Represents a value that can either hold a constant integer value
/// or be encoded as an expression.
#[derive(Clone, Debug)]
pub enum Value {
    Constant(i64),
    Expr(gimli::Expression<R>),
}

#[derive(Clone, Debug)]
pub struct StructureMember {
    pub location: Option<Value>,
    pub name: Option<String>,
    pub ty: TypeId,
}

#[derive(Clone, Debug)]
pub enum ReferenceKind {
    Pointer,
    Reference,
    /// Equivalent to an rvalue reference in C++
    Temporary,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Modifier {
    TypeDef,
    Const,
    Volatile,
    Atomic,
    Restrict,
}

#[derive(Clone, Debug)]
pub enum TypeDeclaration {
    Scalar {
        name: String,
        byte_size: u64,
        encoding: gimli::DwAte,
    },
    Array {
        byte_size: Option<u64>,
        element_type: TypeId,
        lower_bound: Value,
        upper_bound: Option<Value>,
    },
    Referential {
        target: TypeId,
        kind: ReferenceKind,
    },
    Structure {
        name: Option<String>,
        byte_size: u64,
        members: Vec<StructureMember>,
    },
    ModifiedType {
        name: Option<String>,
        modifier: Modifier,
        inner: TypeId,
    },
}

impl Type {
    fn graph(&self) -> Option<&TypeGraph> {
        self.graph.as_deref()
    }

    /// Gets the formatter for this type, if any exist.
    ///
    /// If we have previously called this method on a type, the cached result for that type is returned.
    pub fn formatter(&self) -> Option<Rc<dyn VariableFormatter>> {
        let graph = self.graph()?;

        if let Some(cached) = graph.formatters.borrow().get(&self.root) {
            return cached.clone();
        }

        let debugger = graph.debugger.as_deref()?;
        let formatter = debugger.formatter_for(self);

        graph
            .formatters
            .borrow_mut()
            .insert(self.root, formatter.clone());

        formatter
    }

    /// Returns a [`Type`] over the same graph, rooted at `id`.
    pub fn child(&self, id: TypeId) -> Type {
        Type {
            root: id,
            graph: self.graph.clone(),
        }
    }

    /// For pointer types, returns the target type.
    ///
    /// Modifiers are excluded, e.g. `const int*` returns `int`.
    pub fn pointee(&self) -> Option<Type> {
        match self.resolved()? {
            TypeDeclaration::Referential { target, .. } => Some(self.child(*target)),
            _ => None,
        }
    }

    /// Discards all modifiers (e.g. const, volatile, typedef, using, etc.)
    /// and returns the underlying type.
    ///
    /// If there are no modifiers to discard, returns the same type.
    pub fn skip_modifiers(&self) -> Type {
        let mut curr = self.clone();
        loop {
            let next = curr.skip_one_modifier();
            if next == curr {
                return curr;
            }
            curr = next;
        }
    }

    /// Discards one modifier (e.g. const, volatile, typedef, using, etc.)
    /// and returns the underlying type.
    ///
    /// If there are no modifiers to discard, returns the same type.
    pub fn skip_one_modifier(&self) -> Type {
        let Some(graph) = self.graph() else {
            return self.clone();
        };
        if let Some(TypeDeclaration::ModifiedType { inner, .. }) = graph.decl(self.root) {
            self.child(*inner)
        } else {
            self.clone()
        }
    }

    /// Skips modifiers and returns the underlying declaration.
    ///
    /// Equivalent to the underyling [TypeDeclaration] of [Type::skip_modifiers].
    pub fn resolved(&self) -> Option<&TypeDeclaration> {
        let graph = self.graph()?;
        let mut current = graph.decl(self.root)?;
        loop {
            match current {
                TypeDeclaration::ModifiedType { inner, .. } => {
                    current = graph.decl(*inner)?;
                }
                _ => return Some(current),
            }
        }
    }

    /// Human-readable name of this type (e.g. `int`, `Point`, `int*`).
    pub fn name(&self) -> String {
        let Some(graph) = self.graph() else {
            return "<unknown>".to_string();
        };

        decl_name(self.root, graph)
    }

    /// Checks if the type's fully qualified name matches a regular expression.
    pub fn matches(&self, regex: &str) -> bool {
        let name = self.name();
        match regex::Regex::new(regex) {
            Ok(re) => re.is_match(&name),
            Err(_) => {
                crate::util::warning!("Failed to compile regular expression: {regex}");
                false
            }
        }
    }

    /// Size in bytes of this type, or `None` if unknown.
    pub fn byte_size(&self) -> Option<u64> {
        match self.resolved()? {
            TypeDeclaration::Scalar { byte_size, .. } => Some(*byte_size),
            TypeDeclaration::Structure { byte_size, .. } => Some(*byte_size),
            TypeDeclaration::Array { byte_size, .. } => *byte_size,
            // Pointers/references are wasm32 — 4 bytes
            // TODO: Use the unit address size
            TypeDeclaration::Referential { .. } => Some(4),
            _ => None,
        }
    }

    pub fn die(&self) -> Result<Die<'_>> {
        let graph = self.graph().context("Could not access type graph")?;
        let debugger = graph
            .debugger
            .as_deref()
            .context("Could not access debugger")?;

        self.root.deref(&debugger.info().dwarf)
    }

    pub fn direct_nested_type_with_name(&self, name: &str) -> Result<Type> {
        let graph = self.graph().context("Could not access graph")?;
        let die = self.die()?;
        die.find_children(|child| {
            let Some(child_name) = child.name() else {
                return None;
            };

            if child_name != name {
                return None;
            }

            let id = child.die_ref();
            if graph.contains(&id) {
                Some(graph.get(id))
            } else {
                None
            }
        })
        .context(format!("No such type named {name}"))
    }
}

impl PartialEq for Type {
    fn eq(&self, other: &Self) -> bool {
        self.root == other.root
    }
}

fn decl_name(id: TypeId, graph: &TypeGraph) -> String {
    let Some(decl) = graph.decl(id) else {
        return "<unknown>".to_string();
    };
    match decl {
        TypeDeclaration::Scalar { name, .. } => graph.namespace(id).qualify(name),
        TypeDeclaration::Structure { name, .. } => name
            .as_deref()
            .map(|name| graph.namespace(id).qualify(name))
            .unwrap_or_else(|| "<anonymous>".to_string()),
        TypeDeclaration::Referential { target, kind, .. } => {
            let inner = decl_name(*target, graph);
            match kind {
                ReferenceKind::Pointer => format!("{inner}*"),
                ReferenceKind::Reference => format!("{inner}&"),
                ReferenceKind::Temporary => format!("{inner}&&"),
            }
        }
        TypeDeclaration::Array {
            element_type,
            lower_bound,
            upper_bound,
            ..
        } => {
            let elem = decl_name(*element_type, graph);
            let count = match (lower_bound, upper_bound) {
                (Value::Constant(lo), Some(Value::Constant(hi))) => Some(hi - lo + 1),
                _ => None,
            };
            match count {
                Some(c) => format!("{elem}[{c}]"),
                None => format!("{elem}[]"),
            }
        }
        TypeDeclaration::ModifiedType {
            name,
            modifier,
            inner,
        } => {
            if let Some(name) = name {
                return graph.namespace(id).qualify(name);
            }
            let inner_name = decl_name(*inner, graph);
            match modifier {
                Modifier::TypeDef => inner_name,
                Modifier::Const => format!("const {inner_name}"),
                Modifier::Volatile => format!("volatile {inner_name}"),
                Modifier::Atomic => format!("_Atomic {inner_name}"),
                Modifier::Restrict => format!("restrict {inner_name}"),
            }
        }
    }
}

impl TypeGraph {
    pub fn new(debugger: &WeakRef<Debugger>, dwarf: &Dwarf) -> Ref<TypeGraph> {
        Ref::new_cyclic(|me| {
            let mut types = HashMap::new();
            for unit in dwarf.units() {
                if let Some(root) = unit.root(dwarf) {
                    root.traverse(|die| {
                        if let Some(decl) = parse_type_declaration(&die) {
                            types.insert(die.die_ref(), decl);
                        }
                        Visit::Continue
                    });
                }
            }
            TypeGraph {
                me: me.clone(),
                debugger: debugger.clone(),
                types,
                formatters: Default::default(),
            }
        })
    }

    pub fn get(&self, id: TypeId) -> Type {
        Type {
            root: id,
            graph: self.me.clone(),
        }
    }

    fn decl(&self, id: TypeId) -> Option<&TypeDeclaration> {
        self.types.get(&id)
    }

    fn contains(&self, id: &TypeId) -> bool {
        return self.types.contains_key(id);
    }

    fn namespace(&self, id: TypeId) -> NamespaceHierarchy {
        let Some(debugger) = self.debugger.as_deref() else {
            return NamespaceHierarchy::default();
        };
        weak_error!(id.deref(&debugger.info().dwarf).map(|die| die.namespace())).unwrap_or_default()
    }
}

fn parse_type_declaration(die: &Die<'_>) -> Option<TypeDeclaration> {
    match die.tag() {
        gimli::DW_TAG_base_type => Some(TypeDeclaration::Scalar {
            name: die.name().unwrap_or_default(),
            byte_size: u64_attr(die, gimli::DW_AT_byte_size)?,
            encoding: match die.attr_value(gimli::DW_AT_encoding)? {
                gimli::AttributeValue::Encoding(e) => e,
                _ => return None,
            },
        }),
        gimli::DW_TAG_pointer_type => Some(TypeDeclaration::Referential {
            target: die.type_ref()?,
            kind: ReferenceKind::Pointer,
        }),
        gimli::DW_TAG_reference_type => Some(TypeDeclaration::Referential {
            target: die.type_ref()?,
            kind: ReferenceKind::Reference,
        }),
        gimli::DW_TAG_rvalue_reference_type => Some(TypeDeclaration::Referential {
            target: die.type_ref()?,
            kind: ReferenceKind::Temporary,
        }),
        gimli::DW_TAG_typedef => Some(TypeDeclaration::ModifiedType {
            name: die.name(),
            modifier: Modifier::TypeDef,
            inner: die.type_ref()?,
        }),
        gimli::DW_TAG_const_type => Some(TypeDeclaration::ModifiedType {
            name: die.name(),
            modifier: Modifier::Const,
            inner: die.type_ref()?,
        }),
        gimli::DW_TAG_volatile_type => Some(TypeDeclaration::ModifiedType {
            name: die.name(),
            modifier: Modifier::Volatile,
            inner: die.type_ref()?,
        }),
        gimli::DW_TAG_atomic_type => Some(TypeDeclaration::ModifiedType {
            name: die.name(),
            modifier: Modifier::Atomic,
            inner: die.type_ref()?,
        }),
        gimli::DW_TAG_restrict_type => Some(TypeDeclaration::ModifiedType {
            name: die.name(),
            modifier: Modifier::Restrict,
            inner: die.type_ref()?,
        }),
        gimli::DW_TAG_array_type => {
            let element_type = die.type_ref()?;
            let (lower_bound, upper_bound) = die
                .find_children(|c| {
                    (c.tag() == gimli::DW_TAG_subrange_type).then(|| parse_subrange(&c))
                })
                .unwrap_or((Value::Constant(0), None));
            Some(TypeDeclaration::Array {
                byte_size: u64_attr(die, gimli::DW_AT_byte_size),
                element_type,
                lower_bound,
                upper_bound,
            })
        }
        gimli::DW_TAG_structure_type | gimli::DW_TAG_union_type | gimli::DW_TAG_class_type => {
            Some(TypeDeclaration::Structure {
                name: die.name(),
                byte_size: u64_attr(die, gimli::DW_AT_byte_size)?,
                members: die.collect_children(parse_member),
            })
        }
        _ => None,
    }
}

fn parse_member(die: Die<'_>) -> Option<StructureMember> {
    if die.tag() != gimli::DW_TAG_member {
        return None;
    }
    let ty = die.type_ref()?;
    let location = die
        .attr_value(gimli::DW_AT_data_member_location)
        .and_then(|v| match v {
            gimli::AttributeValue::Udata(u) => Some(Value::Constant(u as i64)),
            gimli::AttributeValue::Sdata(s) => Some(Value::Constant(s)),
            gimli::AttributeValue::Exprloc(e) => Some(Value::Expr(e)),
            _ => None,
        });
    Some(StructureMember {
        location,
        name: die.name(),
        ty,
    })
}

fn parse_subrange(die: &Die<'_>) -> (Value, Option<Value>) {
    let lower = die
        .attr_value(gimli::DW_AT_lower_bound)
        .and_then(array_bound)
        .unwrap_or(Value::Constant(0));
    let upper = die
        .attr_value(gimli::DW_AT_upper_bound)
        .and_then(array_bound)
        .or_else(|| die.attr_value(gimli::DW_AT_count).and_then(array_bound));
    (lower, upper)
}

fn array_bound(value: gimli::AttributeValue<R>) -> Option<Value> {
    match value {
        gimli::AttributeValue::Udata(u) => Some(Value::Constant(u as i64)),
        gimli::AttributeValue::Sdata(s) => Some(Value::Constant(s)),
        gimli::AttributeValue::Exprloc(e) => Some(Value::Expr(e)),
        _ => None,
    }
}

fn u64_attr(die: &Die<'_>, name: gimli::DwAt) -> Option<u64> {
    match die.attr_value(name)? {
        gimli::AttributeValue::Udata(v) => Some(v),
        gimli::AttributeValue::Sdata(s) if s >= 0 => Some(s as u64),
        _ => None,
    }
}
