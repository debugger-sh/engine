pub mod debuggee;

/// Runs the user's script (`sys.argv[1]`) under the debugger, via `python -c BRIDGE`.
pub const BRIDGE: &str = include_str!("bridge.py");
