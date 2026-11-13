//! A worker is a stateless executor: the main thread sends it jobs, each of which
//! runs one WASI program to completion on top of the shared filesystem.

use std::io::Write;

use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasmer::{Instance, Module, Store};
use wasmer_wasix::virtual_fs::{AsyncReadExt, FileSystem};
use wasmer_wasix::{WasiEnv, WasiError, WasiFunctionEnv};

use crate::debug::instrument::{InstrumenterResult, instrument_wasm};
use crate::fs::{Root, Shared, normalize};
use crate::python::worker::BRIDGE;
use crate::util::weak_error;

use debuggee::Debuggee;
use gate::Gate;
use io::{Device, PipeDevice};
use runtime::JsRuntime;

mod debuggee;
pub mod gate;
pub mod io;
mod runtime;

/// How a job should be debugged.
#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Debug {
    /// DWARF inspection and WASM instrumentation.
    Wasm,
    /// The Python bridge (`bdb`).
    Python,
}

/// A program to run, sent by the main thread.
#[derive(Deserialize)]
pub struct Job {
    /// The command name, used as `argv[0]` and in error messages.
    name: String,
    /// The program, as a compiled module…
    #[serde(default, with = "serde_wasm_bindgen::preserve")]
    module: JsValue,
    /// …or as raw bytes…
    #[serde(default, with = "serde_bytes")]
    bytes: Option<Vec<u8>>,
    /// …or as a path in the filesystem.
    path: Option<String>,
    args: Vec<String>,
    env: Vec<(String, String)>,
    workspace: u32,
    sysroot: Option<u32>,
    /// The buffers of the [`PipeDevice`]s used as standard I/O.
    #[serde(with = "serde_wasm_bindgen::preserve")]
    stdin: js_sys::SharedArrayBuffer,
    #[serde(with = "serde_wasm_bindgen::preserve")]
    stdout: js_sys::SharedArrayBuffer,
    #[serde(with = "serde_wasm_bindgen::preserve")]
    stderr: js_sys::SharedArrayBuffer,
    devices: Vec<Device>,
    debug: Option<Debug>,
}

/// Allocates a [`Gate`] for a new worker (main thread).
#[wasm_bindgen]
pub fn gate_new() -> u32 {
    Gate::leak() as *const Gate as u32
}

/// Dooms a worker so that it can be safely terminated (main thread).
#[wasm_bindgen]
pub fn gate_doom(gate: u32) {
    unsafe { &*(gate as *const Gate) }.doom();
}

/// Whether a doomed worker can be safely terminated (main thread).
#[wasm_bindgen]
pub fn gate_idle(gate: u32) -> bool {
    unsafe { &*(gate as *const Gate) }.is_idle()
}

/// Initializes the current worker with its gate.
#[wasm_bindgen]
pub fn worker_init(gate: u32) {
    console_error_panic_hook::set_once();
    gate::install(unsafe { &*(gate as *const Gate) });
}

/// Runs a job to completion, returning its exit code.
#[wasm_bindgen]
pub async fn worker_run(job: JsValue) -> Result<i32, JsError> {
    let job: Job = serde_wasm_bindgen::from_value(job)?;
    run(job).await
}

async fn run(job: Job) -> Result<i32, JsError> {
    let Job { name, module, bytes, path, mut args, env, workspace, sysroot, stdin, stdout, stderr, devices, debug } = job;
    let workspace = unsafe { Shared::from_ptr(workspace) };
    let sysroot = sysroot.map(|ptr| unsafe { Shared::from_ptr(ptr) });
    let fail = |code: i32, message: &str| -> Result<i32, JsError> {
        let message = format!("{name}: {message}\n");
        weak_error!(PipeDevice::new(&stderr, Some(2)).write_all(message.as_bytes()));
        Ok(code)
    };

    /* The Python debugger talks to the bridge through its devices (see `bridge.py`) */
    if debug == Some(Debug::Python) {
        args.splice(0..0, ["-c".to_string(), BRIDGE.to_string()]);
    }
    let fs = Root::new(workspace, sysroot, devices);

    /* Resolve the program */
    let bytes = match (bytes, path) {
        (Some(bytes), _) => Some(bytes),
        (None, Some(path)) => match fs.metadata(&normalize(&path)) {
            Err(_) => return fail(127, "command not found"),
            Ok(metadata) if metadata.is_dir() => return fail(126, "cannot execute"),
            Ok(_) => {
                let mut file = fs.new_open_options().read(true).open(normalize(&path))?;
                let mut bytes = Vec::new();
                file.read_to_end(&mut bytes).await?;
                Some(bytes)
            }
        },
        (None, None) => None,
    };

    /* In debug mode, we need to instrument the binary */
    let mut debuggee = None;
    let bytes = match (bytes, debug == Some(Debug::Wasm)) {
        (Some(wasm), true) => {
            let Ok(InstrumenterResult { info, wasm }) = instrument_wasm(&wasm) else {
                return fail(126, "cannot execute");
            };
            debuggee = Some(Debuggee::new(info));
            Some(wasm)
        }
        (bytes, _) => bytes,
    };

    let mut store = Store::default();
    let module = match bytes {
        Some(bytes) => match Module::from_binary(&store, &bytes) {
            Ok(module) => module,
            Err(_) => return fail(126, "cannot execute"),
        },
        None => Module::from(module.unchecked_into::<js_sys::WebAssembly::Module>()),
    };

    /* Configure the WASI environment */
    let mut builder = WasiEnv::builder(&name)
        .args(&args)
        .envs(env)
        .runtime(JsRuntime::instance())
        .fs(Box::new(fs))
        .stdin(Box::new(PipeDevice::new(&stdin, Some(0))))
        .stdout(Box::new(PipeDevice::new(&stdout, Some(1))))
        .stderr(Box::new(PipeDevice::new(&stderr, Some(2))));
    builder.add_preopen_dir("/")?;

    /* Instantiate the program */
    let instance: Result<Instance, String> = match debuggee {
        Some(debuggee) => (|| {
            let env = builder.build().map_err(|e| e.to_string())?;
            let mut env = WasiFunctionEnv::new(&mut store, env);
            let mut imports = env.import_object(&mut store, &module).map_err(|e| e.to_string())?;
            debuggee.attach(&mut store, &mut imports);
            let instance = Instance::new(&mut store, &module, &imports).map_err(|e| e.to_string())?;
            env.initialize(&mut store, instance.clone()).map_err(|e| e.to_string())?;
            Ok(instance)
        })(),
        None => builder.instantiate(module, &mut store).map(|(i, _)| i).map_err(|e| e.to_string()),
    };
    let start = instance.ok().and_then(|i| i.exports.get_function("_start").ok().cloned());
    let Some(start) = start else {
        return fail(126, "cannot execute");
    };

    /* Run the program, treating `exit(code)` as a normal exit */
    match start.call(&mut store, &[]) {
        Ok(_) => Ok(0),
        Err(err) => match err.downcast_ref::<WasiError>() {
            Some(WasiError::Exit(code)) => Ok(code.raw()),
            _ => fail(134, &err.message()),
        },
    }
}
