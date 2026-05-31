use console_error_panic_hook;
use std::path::{Path, PathBuf};
use wasm_bindgen::prelude::*;
use wasmer_wasix::virtual_fs::{AsyncWriteExt, FileSystem, create_dir_all, mem_fs};
use web_sys::{DedicatedWorkerGlobalScope, MessageEvent};

use crate::types::{FsNode, Lang, WorkerOut, WorkerStart};

mod debuggee;
mod execution;
mod io;
mod runtime;

use execution::Execution;

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Helpers                                                                  │
// ╰──────────────────────────────────────────────────────────────────────────╯

async fn create_user_fs(node: FsNode) -> Result<mem_fs::FileSystem, std::io::Error> {
    let fs = mem_fs::FileSystem::default();
    create_user_fs_rec(&fs, &PathBuf::from("/"), &node).await?;
    Ok(fs)
}

async fn create_user_fs_rec(
    fs: &mem_fs::FileSystem,
    base_path: &PathBuf,
    node: &FsNode,
) -> Result<(), std::io::Error> {
    match node {
        FsNode::File(contents) => {
            let mut file = fs
                .new_open_options()
                .create(true)
                .write(true)
                .open(base_path)?;
            file.write_all(contents.as_bytes())
                .await
                .expect("Failed to write injected file");
            file.flush().await.expect("Flushed file")
        }
        FsNode::Dir(children) => {
            create_dir_all(fs, base_path)?;
            for (name, child_node) in children {
                let mut child_path = base_path.clone();
                child_path.push(name);
                Box::pin(create_user_fs_rec(fs, &child_path, child_node)).await?;
            }
        }
    }
    Ok(())
}

fn is_source_ext(ext: &str, lang: Lang) -> bool {
    match lang {
        Lang::C => matches!(
            ext.to_ascii_lowercase().as_str(),
            "c" | "cc" | "cp" | "cpp" | "cxx" | "c++"
        ),
        Lang::Rust => ext.eq_ignore_ascii_case("rs"),
    }
}

fn collect_sources(node: &FsNode, base_path: &PathBuf, lang: Lang, sources: &mut Vec<String>) {
    match node {
        FsNode::File(_) => {
            if let Some(ext) = base_path.extension().and_then(|ext| ext.to_str()) {
                if is_source_ext(ext, lang) {
                    sources.push(base_path.to_string_lossy().to_string());
                }
            }
        }
        FsNode::Dir(children) => {
            collect_dir_sources(children, base_path, lang, sources);
        }
    }
}

fn collect_dir_sources(
    children: &std::collections::HashMap<String, FsNode>,
    base_path: &PathBuf,
    lang: Lang,
    sources: &mut Vec<String>,
) {
    for (name, child_node) in children {
        let mut child_path = base_path.clone();
        child_path.push(name);
        collect_sources(child_node, &child_path, lang, sources);
    }
}

fn rust_obj_path(source: &str) -> String {
    format!("{}.o", source.trim_end_matches(".rs"))
}

fn collect_rust_objs(fs: &mem_fs::FileSystem, source: &str) -> Vec<String> {
    let obj_path = rust_obj_path(source);
    let mut objs = vec![obj_path.clone()];

    let path = Path::new(source);
    let dir = path.parent().unwrap_or(Path::new("/"));
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");

    let Ok(mut entries) = fs.read_dir(dir) else {
        return objs;
    };
    for entry in entries.by_ref().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(stem) && name.ends_with(".rcgu.o") {
            objs.push(format!("{}/{}", dir.to_string_lossy(), name));
        }
    }
    objs
}

fn find_rust_rlibs(fs: &mem_fs::FileSystem) -> Vec<String> {
    let dir = Path::new("/lib/rustlib/wasm32-wasip1/lib");
    let mut entries = fs.read_dir(dir).expect("Rust sysroot rlib directory");
    let names: Vec<String> = entries
        .by_ref()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();

    [
        "libpanic_abort-",
        "libstd-",
        "libwasi-",
        "libcfg_if-",
        "librustc_demangle-",
        "libstd_detect-",
        "libhashbrown-",
        "librustc_std_workspace_alloc-",
        "libminiz_oxide-",
        "libadler2-",
        "libunwind-",
        "liblibc-",
        "librustc_std_workspace_core-",
        "liballoc-",
        "libcore-",
        "libcompiler_builtins-",
    ]
    .iter()
    .map(|prefix| {
        names
            .iter()
            .find(|name| name.starts_with(prefix) && name.ends_with(".rlib"))
            .map(|name| format!("/lib/rustlib/wasm32-wasip1/lib/{name}"))
            .unwrap_or_else(|| panic!("missing rlib for prefix {prefix}"))
    })
    .collect()
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Worker                                                                   │
// ╰──────────────────────────────────────────────────────────────────────────╯

async fn start_cpp(is_debug: bool, sources: Vec<String>, exec: Execution, fs: mem_fs::FileSystem) {
    let mut obj_paths: Vec<String> = Vec::with_capacity(sources.len());
    let mut union_fs: Option<Box<dyn FileSystem>> = Some(Box::new(fs));

    for source in &sources {
        let obj_path = format!("{source}.o");

        let mut clang_args = vec![
            "-cc1",
            "-triple",
            "wasm32-wasip1",
            "-Werror",
            "-emit-obj",
            "-disable-free",
            "-isysroot",
            "/",
            "-internal-isystem",
            "/include/c++/v1",
            "-internal-isystem",
            "/include",
            "-internal-isystem",
            "/include/wasm32-wasip1",
            "-ferror-limit",
            "4",
            "-fcolor-diagnostics",
            "-x",
            "c++",
            "-std=c++23",
            "-o",
            obj_path.as_str(),
        ];

        if is_debug {
            clang_args.push("-O0");
            clang_args.push("-debug-info-kind=standalone");
            clang_args.push("-dwarf-version=5");
        }

        clang_args.push(source);

        let mut step = exec
            .step("clang")
            .binary("https://fabioibanez.github.io/website/llvm.core.wasm")
            .args(&clang_args);
        if let Some(fs) = union_fs.take() {
            step = step
                .sysroot("https://fabioibanez.github.io/website/llvm-resources.tar.gz")
                .fs(fs);
        }
        let exit = step.run().await.expect("Compilation succeeded");

        if !exit.is_success() {
            return WorkerOut::Stop {
                exit_code: exit.raw(),
            }
            .send();
        }
        obj_paths.push(obj_path);
    }

    let mut link_args: Vec<String> = vec![
        "--export-dynamic".into(),
        "-z".into(),
        "stack-size=1048576".into(),
        "-L/lib/wasm32-wasip1".into(),
        "/lib/wasm32-wasip1/crt1.o".into(),
    ];
    link_args.extend(obj_paths);
    link_args.extend([
        "-lc++".into(),
        "-lc++abi".into(),
        "/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a".into(),
        "-lc".into(),
        "-o".into(),
        "/main.wasm".into(),
    ]);

    let exit = exec
        .step("wasm-ld")
        .binary("https://fabioibanez.github.io/website/llvm.core.wasm")
        .args(link_args.iter().map(String::as_str))
        .run()
        .await
        .expect("Linking succeeded");

    if !exit.is_success() {
        return WorkerOut::Stop {
            exit_code: exit.raw(),
        }
        .send();
    }

    let exit = exec
        .step("main")
        .binary("/main.wasm")
        .debug(is_debug)
        .run()
        .await
        .expect("Running succeeded");

    WorkerOut::Stop {
        exit_code: exit.raw(),
    }
    .send();
}

async fn start_rust(is_debug: bool, sources: Vec<String>, exec: Execution, fs: mem_fs::FileSystem) {
    let mut union_fs: Option<Box<dyn FileSystem>> = Some(Box::new(fs));

    for source in &sources {
        let obj_path = rust_obj_path(source);
        let mut rustc_args = vec![
            source.as_str(),
            "--sysroot",
            "/",
            "--target",
            "wasm32-wasip1",
            "-Cpanic=abort",
            "-Ccodegen-units=1",
            "-Zthreads=1",
            "--emit=obj",
            "-o",
            obj_path.as_str(),
        ];

        if is_debug {
            rustc_args.extend(["-g", "-Copt-level=0"]);
        }

        let mut step = exec
            .step("rustc")
            .binary("https://github.com/debugger-sh/rust/releases/download/debugger-sh-2026-05-30/rustc.wasm")
            .args(&rustc_args);
        if let Some(fs) = union_fs.take() {
            step = step
                .sysroot("https://github.com/debugger-sh/rust/releases/download/debugger-sh-2026-05-30/sysroot.tar.gz")
                .fs(fs);
        }
        let exit = step.run().await.expect("Compilation succeeded");

        if !exit.is_success() {
            return WorkerOut::Stop {
                exit_code: exit.raw(),
            }
            .send();
        }
    }

    let mut link_args: Vec<String> = vec![
        "--export=__main_void".into(),
        "-z".into(),
        "stack-size=1048576".into(),
        "--stack-first".into(),
        "--no-demangle".into(),
        "/lib/rustlib/wasm32-wasip1/lib/self-contained/crt1-command.o".into(),
    ];
    for source in &sources {
        link_args.extend(collect_rust_objs(&exec.fs, source));
    }
    link_args.extend(find_rust_rlibs(&exec.fs));
    link_args.extend([
        "-L/lib/rustlib/wasm32-wasip1/lib/self-contained".into(),
        "-lc".into(),
        "-o".into(),
        "/main.wasm".into(),
        "--gc-sections".into(),
        "-O0".into(),
    ]);

    let exit = exec
        .step("wasm-ld")
        .binary("https://fabioibanez.github.io/website/llvm.core.wasm")
        .args(link_args.iter().map(String::as_str))
        .run()
        .await
        .expect("Linking succeeded");

    if !exit.is_success() {
        return WorkerOut::Stop {
            exit_code: exit.raw(),
        }
        .send();
    }

    let exit = exec
        .step("main")
        .binary("/main.wasm")
        .debug(is_debug)
        .run()
        .await
        .expect("Running succeeded");

    WorkerOut::Stop {
        exit_code: exit.raw(),
    }
    .send();
}

async fn start(msg: WorkerStart) {
    let mut sources = Vec::new();
    collect_dir_sources(&msg.fs, &PathBuf::from("/"), msg.lang, &mut sources);
    sources.sort();

    let lang_name = match msg.lang {
        Lang::C => "C/C++",
        Lang::Rust => "Rust",
    };
    assert!(
        !sources.is_empty(),
        "No {lang_name} source files found in provided filesystem"
    );

    let fs = create_user_fs(FsNode::Dir(msg.fs))
        .await
        .expect("created user files filesystem");

    let exec = Execution::new(msg.stdin_buffer);
    let is_debug = msg.is_debug;
    let lang = msg.lang;

    match lang {
        Lang::C => start_cpp(is_debug, sources, exec, fs).await,
        Lang::Rust => start_rust(is_debug, sources, exec, fs).await,
    }
}

#[wasm_bindgen]
pub fn main() {
    console_error_panic_hook::set_once();
    let scope = DedicatedWorkerGlobalScope::from(JsValue::from(js_sys::global()));

    let onmessage = Closure::wrap(Box::new(move |msg: MessageEvent| {
        let message: WorkerStart = serde_wasm_bindgen::from_value(msg.data()).expect("");
        wasm_bindgen_futures::spawn_local(start(message));
    }) as Box<dyn Fn(MessageEvent)>);
    scope.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    onmessage.forget();

    WorkerOut::Ready.send();
}
