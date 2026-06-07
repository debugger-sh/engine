mod debuggee;

use wasmer_wasix::virtual_fs::{AsyncWriteExt, FileSystem, mem_fs};

use crate::types::{FsNode, WorkerOut, WorkerStart};
use crate::worker::execution::Execution;

use debuggee::PythonDebuggee;

const WASM_URL: &str = "https://runno.dev/langs/python-3.11.3.wasm";
const STDLIB_URL: &str = "https://runno.dev/langs/python-3.11.3.tar.gz";

async fn write_file(fs: &mem_fs::FileSystem, path: &str, contents: &str) {
    let mut file = fs
        .new_open_options()
        .create(true)
        .write(true)
        .truncate(true)
        .open(path)
        .expect("opened file for write");
    file.write_all(contents.as_bytes()).await.expect("wrote file");
    file.flush().await.expect("flushed file");
}

pub async fn start(msg: WorkerStart) {
    let fs = crate::worker::create_user_fs(FsNode::Dir(msg.fs))
        .await
        .expect("created user files filesystem");

    let exec = Execution::new(msg.stdin_buffer);

    let debuggee = msg.is_debug.then(PythonDebuggee::new);
    if let Some(debuggee) = &debuggee {
        write_file(&fs, "/_bridge.py", include_str!("bridge.py")).await;
        debuggee.send_and_wait();
    }

    let mut step = exec
        .step("python")
        .binary(WASM_URL)
        .sysroot(STDLIB_URL)
        .fs(Box::new(fs))
        .args(if msg.is_debug { &["/_bridge.py"][..] } else { &["/main.py"][..] })
        .envs([("PYTHONUNBUFFERED", "1"), ("PYTHONDONTWRITEBYTECODE", "1")]);

    if let Some(debuggee) = debuggee {
        step = step.device_file("/__debug__", Box::new(debuggee.debug_file()));
    }

    let exit = step.run().await.expect("Python execution succeeded");
    WorkerOut::Stop { exit_code: exit.raw() }.send();
}
