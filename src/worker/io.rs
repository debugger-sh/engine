//! Devices shared with the main thread: pipes (which also serve as standard I/O), duplexes
//! and raw shared buffers.

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::pin::Pin;
use std::task::{Context, Poll};

use serde::{Deserialize, Deserializer};
use wasm_bindgen::{JsCast, JsValue};
use wasmer_wasix::virtual_fs::{
    AsyncRead, AsyncSeek, AsyncWrite, FsError, ReadBuf, Result, VirtualFile,
};

use crate::util::weak_error;

/// A device, as sent by the main thread (see `Engine#job` in `src/ts/index.ts`).
#[derive(Debug, Deserialize)]
pub struct Device {
    pub path: PathBuf,
    #[serde(with = "serde_wasm_bindgen::preserve")]
    buffer: js_sys::SharedArrayBuffer,
    /// Whether `buffer` backs a [`PipeDevice`] (rather than a [`SharedBufferDevice`]).
    pipe: bool,
    /// For a [`DuplexDevice`], the buffer of the pipe the main thread writes to (which the
    /// device reads, writing to `buffer`).
    #[serde(default, deserialize_with = "optional")]
    write: Option<js_sys::SharedArrayBuffer>,
}

/// Like `serde_wasm_bindgen::preserve`, for an optional value.
fn optional<'de, D: Deserializer<'de>>(
    de: D,
) -> std::result::Result<Option<js_sys::SharedArrayBuffer>, D::Error> {
    let value: JsValue = serde_wasm_bindgen::preserve::deserialize(de)?;
    Ok(value.dyn_into().ok())
}

// SAFETY: workers are single-threaded, and the buffer is only accessed through atomics or
// (for raw buffers, which make no atomicity guarantees) plain copies.
unsafe impl Send for Device {}
unsafe impl Sync for Device {}

impl Device {
    pub fn open(&self) -> Box<dyn VirtualFile + Send + Sync> {
        match (self.pipe, &self.write) {
            (true, Some(write)) => Box::new(DuplexDevice {
                read: PipeDevice::new(write, None),
                write: PipeDevice::new(&self.buffer, None),
            }),
            (true, None) => Box::new(PipeDevice::new(&self.buffer, None)),
            (false, _) => Box::new(SharedBufferDevice::new(&self.buffer)),
        }
    }
}

/// Implements the async I/O traits on top of [`Read`] and [`Write`], which complete
/// immediately (or block the worker).
macro_rules! blocking_io {
    ($ty:ty) => {
        impl AsyncRead for $ty {
            fn poll_read(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
                let read = self.get_mut().read(buf.initialize_unfilled())?;
                buf.advance(read);
                Poll::Ready(Ok(()))
            }
        }

        impl AsyncWrite for $ty {
            fn poll_write(self: Pin<&mut Self>, _: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
                Poll::Ready(self.get_mut().write(buf))
            }
            fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
                Poll::Ready(Ok(()))
            }
            fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
                Poll::Ready(Ok(()))
            }
        }
    };
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ PipeDevice                                                               │
// ╰──────────────────────────────────────────────────────────────────────────╯

// Must match the TypeScript `Pipe` layout: [read index, write index, sequence, closed].
const HEADER_SIZE: u32 = 16;
const READ_IDX: u32 = 0;
const WRITE_IDX: u32 = 1;
const SEQ_IDX: u32 = 2;
const CLOSED_IDX: u32 = 3;

/// A byte stream over a ring buffer shared with the main thread (see `Pipe` in
/// `src/ts/process.ts`). Every read, write and close bumps the sequence number, which
/// blocked readers and writers wait on.
#[derive(Debug)]
pub struct PipeDevice {
    header: js_sys::Int32Array,
    data: js_sys::Uint8Array,
    /// The standard stream this pipe is attached to, if any. A process may only read its
    /// stdin, and only write its stdout and stderr; other pipes are read-write.
    fd: Option<u32>,
}

// SAFETY: see `Device`.
unsafe impl Send for PipeDevice {}
unsafe impl Sync for PipeDevice {}

impl PipeDevice {
    pub fn new(buffer: &js_sys::SharedArrayBuffer, fd: Option<u32>) -> Self {
        let header = js_sys::Int32Array::new_with_byte_offset_and_length(buffer, 0, 4);
        let data = js_sys::Uint8Array::new_with_byte_offset(buffer, HEADER_SIZE);
        Self { header, data, fd }
    }

    fn load(&self, index: u32) -> u32 {
        js_sys::Atomics::load(&self.header, index).expect("loaded pipe index") as u32
    }

    fn store(&self, index: u32, value: u32) {
        js_sys::Atomics::store(&self.header, index, value as i32).expect("stored pipe index");
    }

    /// The number of bytes which can be written without blocking.
    fn free(&self) -> u32 {
        let len = self.data.length();
        // One slot is always kept empty to distinguish full from empty.
        (self.load(READ_IDX) + len - self.load(WRITE_IDX) - 1) % len
    }

    /// Bumps the sequence number, waking every blocked reader and writer.
    fn notify(&self) {
        js_sys::Atomics::add(&self.header, SEQ_IDX, 1).expect("bumped pipe sequence");
        js_sys::Atomics::notify(&self.header, SEQ_IDX).expect("notified pipe");
    }
}

impl Read for PipeDevice {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if matches!(self.fd, Some(1 | 2)) {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "cannot read from stdout"));
        }
        // Unbuffered readers follow each 1-byte read with a 0-byte one, which mustn't block.
        if buf.is_empty() {
            return Ok(0);
        }
        let (read, write) = loop {
            // Load the sequence number first so that no write (or close) is missed.
            let seq = self.load(SEQ_IDX);
            let (read, write) = (self.load(READ_IDX), self.load(WRITE_IDX));
            if read != write {
                break (read, write);
            }
            if self.load(CLOSED_IDX) != 0 {
                return Ok(0); // EOF
            }
            weak_error!(js_sys::Atomics::wait(&self.header, SEQ_IDX, seq as i32));
        };

        // Only read the contiguous bytes before the buffer wraps.
        let len = self.data.length();
        let end = if read < write { write } else { len };
        let count = (end - read).min(buf.len() as u32);
        self.data.subarray(read, read + count).copy_to(&mut buf[..count as usize]);
        self.store(READ_IDX, (read + count) % len);
        self.notify();
        Ok(count as usize)
    }
}

impl Write for PipeDevice {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.fd == Some(0) {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "cannot write to stdin"));
        }
        if buf.is_empty() {
            return Ok(0);
        }
        let free = loop {
            // Load the sequence number first so that no read (or close) is missed.
            let seq = self.load(SEQ_IDX);
            if self.load(CLOSED_IDX) != 0 {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            match self.free() {
                0 => weak_error!(js_sys::Atomics::wait(&self.header, SEQ_IDX, seq as i32)),
                free => break free,
            };
        };

        // Only write the contiguous bytes before the buffer wraps.
        let (len, write) = (self.data.length(), self.load(WRITE_IDX));
        let count = free.min(len - write).min(buf.len() as u32);
        self.data.subarray(write, write + count).copy_from(&buf[..count as usize]);
        self.store(WRITE_IDX, (write + count) % len);
        self.notify();
        Ok(count as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

blocking_io!(PipeDevice);

impl AsyncSeek for PipeDevice {
    // Reads and writes of files are preceded by a seek, which pipes ignore.
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for PipeDevice {
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
    fn get_special_fd(&self) -> Option<u32> {
        self.fd
    }
    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }
    fn poll_write_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(self.free() as usize))
    }
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ DuplexDevice                                                             │
// ╰──────────────────────────────────────────────────────────────────────────╯

/// A pair of pipes (see `Duplex` in `src/ts/process.ts`): reads come from `read`, and
/// writes go to `write`. Everything else is inherited from the pipe in that direction.
#[derive(Debug)]
pub struct DuplexDevice {
    read: PipeDevice,
    write: PipeDevice,
}

impl Read for DuplexDevice {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.read.read(buf)
    }
}

impl Write for DuplexDevice {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.write.flush()
    }
}

blocking_io!(DuplexDevice);

impl AsyncSeek for DuplexDevice {
    fn start_seek(self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        Pin::new(&mut self.get_mut().read).start_seek(position)
    }

    fn poll_complete(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut self.get_mut().read).poll_complete(cx)
    }
}

impl VirtualFile for DuplexDevice {
    fn last_accessed(&self) -> u64 {
        self.read.last_accessed()
    }
    fn last_modified(&self) -> u64 {
        self.read.last_modified()
    }
    fn created_time(&self) -> u64 {
        self.read.created_time()
    }
    fn size(&self) -> u64 {
        self.read.size()
    }
    fn set_len(&mut self, new_size: u64) -> Result<()> {
        self.read.set_len(new_size)
    }
    fn unlink(&mut self) -> Result<()> {
        self.read.unlink()
    }
    fn get_special_fd(&self) -> Option<u32> {
        self.read.get_special_fd()
    }
    fn poll_read_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().read).poll_read_ready(cx)
    }
    fn poll_write_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().write).poll_write_ready(cx)
    }
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ SharedBufferDevice                                                       │
// ╰──────────────────────────────────────────────────────────────────────────╯

/// A fixed-size file backed by a shared buffer, which is read and written in place.
#[derive(Debug)]
pub struct SharedBufferDevice {
    data: js_sys::Uint8Array,
    position: u64,
}

// SAFETY: see `Device`.
unsafe impl Send for SharedBufferDevice {}
unsafe impl Sync for SharedBufferDevice {}

impl SharedBufferDevice {
    pub fn new(buffer: &js_sys::SharedArrayBuffer) -> Self {
        Self { data: js_sys::Uint8Array::new(buffer), position: 0 }
    }

    /// The range of up to `count` bytes at the current position, advancing past it.
    fn take(&mut self, count: usize) -> js_sys::Uint8Array {
        let len = self.data.length();
        let start = self.position.min(len as u64) as u32;
        let end = start + (count as u32).min(len - start);
        self.position += (end - start) as u64;
        self.data.subarray(start, end)
    }
}

impl Read for SharedBufferDevice {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let range = self.take(buf.len());
        let count = range.length() as usize;
        range.copy_to(&mut buf[..count]);
        Ok(count)
    }
}

impl Write for SharedBufferDevice {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let range = self.take(buf.len());
        let count = range.length() as usize;
        if count == 0 && !buf.is_empty() {
            return Err(io::ErrorKind::WriteZero.into()); // Past the end
        }
        range.copy_from(&buf[..count]);
        Ok(count)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

blocking_io!(SharedBufferDevice);

impl AsyncSeek for SharedBufferDevice {
    fn start_seek(mut self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        let position = match position {
            io::SeekFrom::Start(offset) => Some(offset),
            io::SeekFrom::End(offset) => self.size().checked_add_signed(offset),
            io::SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        };
        self.position = position.ok_or(io::ErrorKind::InvalidInput)?;
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(self.position))
    }
}

impl VirtualFile for SharedBufferDevice {
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
        self.data.length() as u64
    }
    fn set_len(&mut self, _new_size: u64) -> Result<()> {
        Err(FsError::Unsupported)
    }
    fn unlink(&mut self) -> Result<()> {
        Ok(())
    }
    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(self.size().saturating_sub(self.position) as usize))
    }
    fn poll_write_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        self.poll_read_ready(cx)
    }
}
