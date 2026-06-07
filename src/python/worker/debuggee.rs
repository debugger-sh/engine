use std::{
    io::{self, IoSlice},
    pin::Pin,
    task::{Context, Poll},
};

use serde::Deserialize;
use wasmer_wasix::virtual_fs::{AsyncRead, AsyncSeek, AsyncWrite, Result, VirtualFile};

use crate::types::{PauseReason, WorkerOut};
use crate::util::weak_error;

#[derive(Deserialize)]
struct PythonPauseMeta {
    reason: String,
}

fn pause_reason(json: &str) -> PauseReason {
    match serde_json::from_str::<PythonPauseMeta>(json).ok() {
        Some(p) if p.reason == "breakpoint" => PauseReason::Breakpoint,
        _ => PauseReason::Step,
    }
}

/// SAB layout:
/// - bytes 0..12: 3 x i32 — [0] pause/resume signal, [1] command, [2] response length
/// - bytes 12..: UTF-8 JSON resume payload written by the main thread
const PYTHON_DEBUG_SAB_SIZE: u32 = 4096;
const PYTHON_DEBUG_HEADER: u32 = 12;

pub struct PythonDebuggee {
    sab: js_sys::SharedArrayBuffer,
    control: js_sys::Int32Array,
    response: js_sys::Uint8Array,
}

impl PythonDebuggee {
    pub fn new() -> Self {
        let sab = js_sys::SharedArrayBuffer::new(PYTHON_DEBUG_SAB_SIZE);
        let control = js_sys::Int32Array::new_with_byte_offset_and_length(&sab, 0, 3);
        let response = js_sys::Uint8Array::new_with_byte_offset(&sab, PYTHON_DEBUG_HEADER);
        Self {
            sab,
            control,
            response,
        }
    }

    /// Sends the SAB to the main thread, then blocks until `configurationDone`.
    pub fn send_and_wait(&self) {
        WorkerOut::PythonDebug {
            state: self.sab.clone(),
        }
        .send();
        weak_error!(js_sys::Atomics::wait(&self.control, 0, 0));
    }

    pub fn debug_file(&self) -> DebugFile {
        DebugFile::new(self.control.clone(), self.response.clone())
    }
}

#[derive(Debug)]
pub struct DebugFile {
    control: js_sys::Int32Array,
    response: js_sys::Uint8Array,
    pending_response: Option<Vec<u8>>,
    read_offset: usize,
}

unsafe impl Send for DebugFile {}
unsafe impl Sync for DebugFile {}

impl DebugFile {
    pub fn new(control: js_sys::Int32Array, response: js_sys::Uint8Array) -> Self {
        let mut file = Self {
            control,
            response,
            pending_response: None,
            read_offset: 0,
        };
        let len = js_sys::Atomics::load(&file.control, 2).unwrap_or(0) as u32;
        if len > 0 {
            let json = file.response.slice(0, len);
            file.pending_response = Some(json.to_vec());
        }
        file
    }
}

impl AsyncWrite for DebugFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let frame = String::from_utf8_lossy(buf).into_owned();
        WorkerOut::Paused {
            reason: pause_reason(&frame),
            frame: Some(frame),
        }
        .send();

        js_sys::Atomics::store(&self.control, 0, 0).expect("stored pause signal");
        weak_error!(js_sys::Atomics::wait(&self.control, 0, 0));

        let len = js_sys::Atomics::load(&self.control, 2).expect("loaded response length") as u32;
        let json = self.response.slice(0, len);
        self.pending_response = Some(json.to_vec());
        self.read_offset = 0;

        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(cx)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let len: usize = bufs.iter().map(|b| b.len()).sum();
        if len == 0 {
            return Poll::Ready(Ok(0));
        }
        let mut flat = Vec::with_capacity(len);
        for buf in bufs {
            flat.extend_from_slice(buf);
        }
        Pin::new(self.get_mut()).poll_write(cx, &flat)
    }

    fn is_write_vectored(&self) -> bool {
        false
    }
}

impl AsyncRead for DebugFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut wasmer_wasix::virtual_fs::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let Some(data) = &self.pending_response else {
            return Poll::Ready(Ok(()));
        };

        if self.read_offset >= data.len() {
            self.pending_response = None;
            self.read_offset = 0;
            return Poll::Ready(Ok(()));
        }

        let to_read = std::cmp::min(buf.remaining(), data.len() - self.read_offset);
        buf.put_slice(&data[self.read_offset..self.read_offset + to_read]);
        self.read_offset += to_read;
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for DebugFile {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for DebugFile {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        0
    }

    fn set_len(&mut self, _new_size: u64) -> Result<()> {
        Ok(())
    }

    fn unlink(&mut self) -> Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let pending = self
            .pending_response
            .as_ref()
            .map(|data| data.len().saturating_sub(self.read_offset))
            .unwrap_or(8192);
        Poll::Ready(Ok(pending))
    }

    fn poll_write_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }
}
