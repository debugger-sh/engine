//! The engine's shared in-memory filesystem.
//!
//! The workspace (and every sysroot) is a Wasmer [`mem_fs::FileSystem`] living in the
//! linear memory shared by the main thread and all workers, so every thread operates
//! on the same files with zero copies.
//!
//! All accesses are serialized by one global lock. Workers block on it ([`Shared`]),
//! whereas the main thread must never block: its operations ([`Fs`]) are `async`, and
//! yield to the event loop while the lock is taken.

use std::io::{self, Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};

use futures::FutureExt;
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use wasm_bindgen::prelude::*;
use wasmer_wasix::virtual_fs::{
    AsyncRead, AsyncReadExt, AsyncSeek, AsyncWrite, AsyncWriteExt, FileOpener, FileSystem, FileType,
    FsError, Metadata, OpenOptions, OpenOptionsConfig, OverlayFileSystem, ReadBuf, ReadDir,
    VirtualFile, create_dir_all, mem_fs,
};

use crate::worker::gate::Critical;
use crate::worker::io::Device;

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Locking                                                                  │
// ╰──────────────────────────────────────────────────────────────────────────╯

static LOCK: AtomicBool = AtomicBool::new(false);

fn try_lock() -> bool {
    LOCK.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_ok()
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(callback: &js_sys::Function, ms: i32);
}

/// Holds the filesystem lock (and marks a critical section) until dropped.
struct Guard(#[allow(dead_code)] Critical);

impl Guard {
    /// Takes the filesystem lock, spinning until it is available. Worker-only.
    fn lock() -> Self {
        let critical = Critical::enter();
        while !try_lock() {
            std::hint::spin_loop();
        }
        Self(critical)
    }

    /// Takes the filesystem lock without ever blocking: while it is taken, yields to
    /// the event loop and retries. Main thread-only, since the main thread must never
    /// block on (or spin for) a worker.
    async fn lock_async() -> Self {
        while !try_lock() {
            let tick = js_sys::Promise::new(&mut |resolve, _| set_timeout(&resolve, 0));
            let _ = wasm_bindgen_futures::JsFuture::from(tick).await;
        }
        Self(Critical::enter())
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        LOCK.store(false, Ordering::Release);
    }
}

/// Runs in-memory I/O, which always completes immediately.
fn now<F: Future>(future: F) -> F::Output {
    future.now_or_never().expect("in-memory I/O completes synchronously")
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Worker-side filesystems                                                  │
// ╰──────────────────────────────────────────────────────────────────────────╯

/// A shared filesystem as seen from a worker: every operation takes the lock.
#[derive(Debug, Clone)]
pub struct Shared(pub mem_fs::FileSystem);

impl Shared {
    /// Clones the filesystem handle behind a pointer obtained from [`Fs::ptr`].
    ///
    /// # Safety
    /// `ptr` must come from a live [`Fs`].
    pub unsafe fn from_ptr(ptr: u32) -> Self {
        Self(unsafe { &*(ptr as *const mem_fs::FileSystem) }.clone())
    }
}

impl FileSystem for Shared {
    fn readlink(&self, path: &Path) -> Result<PathBuf, FsError> {
        let _guard = Guard::lock();
        self.0.readlink(path)
    }
    fn read_dir(&self, path: &Path) -> Result<ReadDir, FsError> {
        let _guard = Guard::lock();
        self.0.read_dir(path)
    }
    fn create_dir(&self, path: &Path) -> Result<(), FsError> {
        let _guard = Guard::lock();
        self.0.create_dir(path)
    }
    fn remove_dir(&self, path: &Path) -> Result<(), FsError> {
        let _guard = Guard::lock();
        self.0.remove_dir(path)
    }
    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, Result<(), FsError>> {
        let _guard = Guard::lock();
        let result = now(self.0.rename(from, to));
        Box::pin(async move { result })
    }
    fn metadata(&self, path: &Path) -> Result<Metadata, FsError> {
        let _guard = Guard::lock();
        self.0.metadata(path)
    }
    fn symlink_metadata(&self, path: &Path) -> Result<Metadata, FsError> {
        let _guard = Guard::lock();
        self.0.symlink_metadata(path)
    }
    fn remove_file(&self, path: &Path) -> Result<(), FsError> {
        let _guard = Guard::lock();
        self.0.remove_file(path)
    }
    fn new_open_options(&self) -> OpenOptions<'_> {
        OpenOptions::new(self)
    }
    fn mount(&self, _: String, _: &Path, _: Box<dyn FileSystem + Send + Sync>) -> Result<(), FsError> {
        Err(FsError::Unsupported)
    }
}

impl FileOpener for Shared {
    fn open(
        &self,
        path: &Path,
        conf: &OpenOptionsConfig,
    ) -> Result<Box<dyn VirtualFile + Send + Sync>, FsError> {
        let _guard = Guard::lock();
        let file = self.0.new_open_options().options(conf.clone()).open(path)?;
        Ok(Box::new(SharedFile(file)))
    }
}

/// A file opened through [`Shared`]: every operation takes the lock.
#[derive(Debug)]
struct SharedFile(Box<dyn VirtualFile + Send + Sync>);

macro_rules! locked {
    ($self:ident.$method:ident($($arg:expr),*)) => {{
        let _guard = Guard::lock();
        $self.0.$method($($arg),*)
    }};
    (pin $self:ident.$method:ident($($arg:expr),*)) => {{
        let _guard = Guard::lock();
        Pin::new(&mut *$self.0).$method($($arg),*)
    }};
}

impl VirtualFile for SharedFile {
    fn last_accessed(&self) -> u64 {
        locked!(self.last_accessed())
    }
    fn last_modified(&self) -> u64 {
        locked!(self.last_modified())
    }
    fn created_time(&self) -> u64 {
        locked!(self.created_time())
    }
    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> Result<(), FsError> {
        locked!(self.set_times(atime, mtime))
    }
    fn size(&self) -> u64 {
        locked!(self.size())
    }
    fn set_len(&mut self, new_size: u64) -> Result<(), FsError> {
        locked!(self.set_len(new_size))
    }
    fn unlink(&mut self) -> Result<(), FsError> {
        locked!(self.unlink())
    }
    fn poll_read_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        locked!(pin self.poll_read_ready(cx))
    }
    fn poll_write_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        locked!(pin self.poll_write_ready(cx))
    }
}

impl AsyncRead for SharedFile {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        locked!(pin self.poll_read(cx, buf))
    }
}

impl AsyncWrite for SharedFile {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        locked!(pin self.poll_write(cx, buf))
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        locked!(pin self.poll_flush(cx))
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        locked!(pin self.poll_shutdown(cx))
    }
}

impl AsyncSeek for SharedFile {
    fn start_seek(mut self: Pin<&mut Self>, position: io::SeekFrom) -> io::Result<()> {
        locked!(pin self.start_seek(position))
    }
    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        locked!(pin self.poll_complete(cx))
    }
}

/// The root filesystem of a process: the shared workspace with its sysroot overlaid
/// beneath it, and its devices on top (both visible only to this process).
pub struct Root {
    fs: OverlayFileSystem<Shared, Vec<Shared>>,
    devices: Vec<Device>,
}

impl Root {
    pub fn new(workspace: Shared, sysroot: Option<Shared>, devices: Vec<Device>) -> Self {
        let fs = OverlayFileSystem::new(workspace, sysroot.into_iter().collect());
        Self { fs, devices }
    }

    fn device(&self, path: &Path) -> Option<&Device> {
        self.devices.iter().find(|device| device.path == path)
    }
}

impl std::fmt::Debug for Root {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.fs.fmt(f)
    }
}

impl FileSystem for Root {
    fn readlink(&self, path: &Path) -> Result<PathBuf, FsError> {
        self.fs.readlink(path)
    }
    fn read_dir(&self, path: &Path) -> Result<ReadDir, FsError> {
        self.fs.read_dir(path)
    }
    fn create_dir(&self, path: &Path) -> Result<(), FsError> {
        self.fs.create_dir(path)
    }
    fn remove_dir(&self, path: &Path) -> Result<(), FsError> {
        self.fs.remove_dir(path)
    }
    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, Result<(), FsError>> {
        self.fs.rename(from, to)
    }
    fn metadata(&self, path: &Path) -> Result<Metadata, FsError> {
        if let Some(device) = self.device(path) {
            return Ok(Metadata { ft: FileType::new_file(), len: device.open().size(), ..Default::default() });
        }
        // Devices may be placed in directories which don't exist: so that paths to them
        // resolve, their missing ancestors are shown as directories.
        self.fs.metadata(path).or_else(|err| match self.devices.iter().any(|d| d.path.starts_with(path)) {
            true => Ok(Metadata { ft: FileType::new_dir(), ..Default::default() }),
            false => Err(err),
        })
    }
    fn symlink_metadata(&self, path: &Path) -> Result<Metadata, FsError> {
        self.metadata(path)
    }
    fn remove_file(&self, path: &Path) -> Result<(), FsError> {
        self.fs.remove_file(path)
    }
    fn new_open_options(&self) -> OpenOptions<'_> {
        OpenOptions::new(self)
    }
    fn mount(&self, _: String, _: &Path, _: Box<dyn FileSystem + Send + Sync>) -> Result<(), FsError> {
        Err(FsError::Unsupported)
    }
}

impl FileOpener for Root {
    fn open(
        &self,
        path: &Path,
        conf: &OpenOptionsConfig,
    ) -> Result<Box<dyn VirtualFile + Send + Sync>, FsError> {
        match self.device(path) {
            Some(device) => Ok(device.open()),
            None => self.fs.new_open_options().options(conf.clone()).open(path),
        }
    }
}

// ╭──────────────────────────────────────────────────────────────────────────╮
// │ Main-thread API                                                          │
// ╰──────────────────────────────────────────────────────────────────────────╯

/// An owned handle to a shared filesystem (the workspace or a sysroot), for the main
/// thread. Every operation takes the lock (see [`Guard::lock_async`]).
#[wasm_bindgen]
pub struct Fs(*mut mem_fs::FileSystem);

impl Drop for Fs {
    fn drop(&mut self) {
        drop(unsafe { Box::from_raw(self.0) });
    }
}

impl Fs {
    pub fn from_fs(fs: mem_fs::FileSystem) -> Self {
        Self(Box::into_raw(Box::new(fs)))
    }

    fn fs(&self) -> &mem_fs::FileSystem {
        unsafe { &*self.0 }
    }

    fn open(&self, path: &Path, write: bool) -> Result<Box<dyn VirtualFile + Send + Sync>, FsError> {
        let mut options = self.fs().new_open_options();
        if write {
            options.write(true).create(true).truncate(true);
        } else {
            options.read(true);
        }
        options.open(path)
    }

    fn write(&self, path: &Path, contents: &[u8], atime: Option<u64>, mtime: Option<u64>) -> Result<(), FsError> {
        let mut file = self.open(path, true)?;
        now(file.write_all(contents))?;
        file.set_times(atime, mtime)
    }

    fn read(&self, path: &Path) -> Result<Vec<u8>, FsError> {
        let mut file = self.open(path, false)?;
        let mut contents = Vec::new();
        now(file.read_to_end(&mut contents))?;
        Ok(contents)
    }

    /// Lists every entry beneath `root` (relative, `/`-separated, depth-first, sorted).
    fn walk(&self, root: &Path, prefix: &str, out: &mut Vec<(String, Metadata)>) -> Result<(), FsError> {
        let mut entries: Vec<_> = self.fs().read_dir(root)?.flatten().collect();
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        for entry in entries {
            let name = format!("{prefix}{}", entry.file_name().to_string_lossy());
            let metadata = entry.metadata?;
            let is_dir = metadata.is_dir();
            out.push((name.clone(), metadata));
            if is_dir {
                self.walk(&entry.path, &format!("{name}/"), out)?;
            }
        }
        Ok(())
    }

    /// Entries beneath `at` matching `include` but not `exclude`.
    fn matches(&self, at: &Path, include: Vec<String>, exclude: Vec<String>) -> Result<Vec<(String, Metadata)>, JsError> {
        let (include, exclude) = (globs(&include)?, globs(&exclude)?);
        let mut entries = Vec::new();
        self.walk(at, "", &mut entries).map_err(|e| fs_error(e, at))?;
        entries.retain(|(name, _)| include.is_match(name) && !exclude.is_match(name));
        Ok(entries)
    }

    /// Extracts a tarball (optionally gzipped) or zip archive into `at`.
    fn extract(&self, at: &Path, bytes: &[u8]) -> Result<(), JsError> {
        let fs = self.fs();
        create_dir_all(fs, at).map_err(|e| fs_error(e, at))?;
        let write = |path: &Path, is_dir: bool, contents: &[u8], mtime: Option<u64>| {
            let path = normalize(at.join(path));
            let dir = if is_dir { Some(path.as_path()) } else { path.parent() };
            if let Some(dir) = dir {
                create_dir_all(fs, dir).map_err(|e| fs_error(e, dir))?;
            }
            match is_dir {
                true => Ok(()),
                false => self.write(&path, contents, mtime, mtime).map_err(|e| fs_error(e, &path)),
            }
        };

        if bytes.starts_with(b"PK") {
            let mut zip = zip::ZipArchive::new(Cursor::new(bytes))?;
            for i in 0..zip.len() {
                let mut entry = zip.by_index(i)?;
                let Some(path) = entry.enclosed_name() else { continue };
                let mut contents = Vec::new();
                entry.read_to_end(&mut contents)?;
                write(&path, entry.is_dir(), &contents, None)?;
            }
            return Ok(());
        }

        let reader: Box<dyn Read> = match bytes.starts_with(&[0x1f, 0x8b]) {
            true => Box::new(flate2::read::GzDecoder::new(bytes)),
            false => Box::new(bytes),
        };
        for entry in tar::Archive::new(reader).entries()? {
            let mut entry = entry?;
            let kind = entry.header().entry_type();
            if !kind.is_file() && !kind.is_dir() {
                continue;
            }
            let mtime = entry.header().mtime().ok().map(|s| s * 1_000_000_000);
            let path = entry.path()?.into_owned();
            let mut contents = Vec::new();
            entry.read_to_end(&mut contents)?;
            write(&path, kind.is_dir(), &contents, mtime)?;
        }
        Ok(())
    }
}

#[wasm_bindgen]
impl Fs {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::from_fs(mem_fs::FileSystem::default())
    }

    /// A pointer through which workers may borrow this filesystem (see [`Shared::from_ptr`]).
    pub fn ptr(&self) -> u32 {
        self.0 as u32
    }

    /// Unions the contents of a tarball or zip archive into the directory `at`.
    pub async fn mount(&self, at: String, bytes: Vec<u8>) -> Result<(), JsError> {
        let _guard = Guard::lock_async().await;
        self.extract(&normalize(at), &bytes)
    }

    #[wasm_bindgen(js_name = "readFile")]
    pub async fn read_file(&self, path: String) -> Result<Vec<u8>, JsError> {
        let _guard = Guard::lock_async().await;
        let path = normalize(path);
        self.read(&path).map_err(|e| fs_error(e, &path))
    }

    /// Writes a file. Times are in milliseconds since the epoch, defaulting to now.
    #[wasm_bindgen(js_name = "writeFile")]
    pub async fn write_file(&self, path: String, contents: Vec<u8>, modified: Option<f64>, accessed: Option<f64>) -> Result<(), JsError> {
        let _guard = Guard::lock_async().await;
        let path = normalize(path);
        let ns = |ms: Option<f64>| ms.map(|ms| (ms * 1e6) as u64);
        self.write(&path, &contents, ns(accessed), ns(modified)).map_err(|e| fs_error(e, &path))
    }

    pub async fn mkdir(&self, path: String, recursive: bool) -> Result<(), JsError> {
        let _guard = Guard::lock_async().await;
        let path = normalize(path);
        match recursive {
            true => create_dir_all(self.fs(), &path),
            false => self.fs().create_dir(&path),
        }
        .map_err(|e| fs_error(e, &path))
    }

    pub async fn remove(&self, path: String, recursive: bool) -> Result<(), JsError> {
        let _guard = Guard::lock_async().await;
        let path = normalize(path);
        let fs = self.fs();
        let metadata = fs.metadata(&path).map_err(|e| fs_error(e, &path))?;
        if !metadata.is_dir() {
            return fs.remove_file(&path).map_err(|e| fs_error(e, &path));
        }
        if recursive {
            let mut entries = Vec::new();
            self.walk(&path, "", &mut entries).map_err(|e| fs_error(e, &path))?;
            for (name, metadata) in entries.iter().rev() {
                let child = path.join(name);
                match metadata.is_dir() {
                    true => fs.remove_dir(&child),
                    false => fs.remove_file(&child),
                }
                .map_err(|e| fs_error(e, &child))?;
            }
        }
        fs.remove_dir(&path).map_err(|e| fs_error(e, &path))
    }

    pub async fn rename(&self, from: String, to: String) -> Result<(), JsError> {
        let _guard = Guard::lock_async().await;
        let (from, to) = (normalize(from), normalize(to));
        now(self.fs().rename(&from, &to)).map_err(|e| fs_error(e, &from))
    }

    /// Returns `[isDir, size, modified, accessed, created]` (times in milliseconds).
    pub async fn stat(&self, path: String) -> Result<Vec<f64>, JsError> {
        let _guard = Guard::lock_async().await;
        let path = normalize(path);
        let m = self.fs().metadata(&path).map_err(|e| fs_error(e, &path))?;
        let ms = |ns: u64| (ns / 1_000_000) as f64;
        let size = if m.is_dir() { 0 } else { m.len };
        Ok(vec![m.is_dir() as u8 as f64, size as f64, ms(m.modified), ms(m.accessed), ms(m.created)])
    }

    #[wasm_bindgen(js_name = "readDir")]
    pub async fn read_dir(&self, path: String) -> Result<Vec<String>, JsError> {
        let _guard = Guard::lock_async().await;
        let path = normalize(path);
        let entries = self.fs().read_dir(&path).map_err(|e| fs_error(e, &path))?;
        let mut names: Vec<String> = entries
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        Ok(names)
    }

    /// Paths beneath `at` (relative to it) matching `include` but not `exclude`.
    /// Directories are suffixed with `/`.
    pub async fn glob(&self, at: String, include: Vec<String>, exclude: Vec<String>) -> Result<Vec<String>, JsError> {
        let _guard = Guard::lock_async().await;
        let entries = self.matches(&normalize(at), include, exclude)?;
        Ok(entries
            .into_iter()
            .map(|(name, m)| if m.is_dir() { format!("{name}/") } else { name })
            .collect())
    }

    /// A hash of a file's contents, or `undefined` if it cannot be read.
    pub async fn hash(&self, path: String) -> Option<String> {
        let _guard = Guard::lock_async().await;
        let contents = self.read(&normalize(path)).ok()?;
        Some(format!("{:08x}", crc32fast::hash(&contents)))
    }

    /// Exports the matching entries beneath `at` as a `.tar.gz` (or `.zip`) archive.
    pub async fn archive(&self, at: String, include: Vec<String>, exclude: Vec<String>, zip: bool) -> Result<Vec<u8>, JsError> {
        let _guard = Guard::lock_async().await;
        let at = normalize(at);
        let entries = self.matches(&at, include, exclude)?;
        let contents = |name: &str| self.read(&at.join(name)).map_err(|e| fs_error(e, &at.join(name)));

        if zip {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            for (name, metadata) in &entries {
                let options = zip::write::SimpleFileOptions::default();
                match metadata.is_dir() {
                    true => zip.add_directory(name.as_str(), options)?,
                    false => {
                        zip.start_file(name.as_str(), options)?;
                        zip.write_all(&contents(name)?)?;
                    }
                }
            }
            return Ok(zip.finish()?.into_inner());
        }

        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        for (name, metadata) in &entries {
            let mut header = tar::Header::new_gnu();
            header.set_mtime(metadata.modified / 1_000_000_000);
            if metadata.is_dir() {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_mode(0o755);
                header.set_size(0);
                tar.append_data(&mut header, name, io::empty())?;
            } else {
                let contents = contents(name)?;
                header.set_mode(0o644);
                header.set_size(contents.len() as u64);
                tar.append_data(&mut header, name, contents.as_slice())?;
            }
        }
        Ok(tar.into_inner()?.finish()?)
    }
}

/// Resolves a path against `/`, lexically handling `.` and `..`.
pub fn normalize(path: impl AsRef<Path>) -> PathBuf {
    let mut out = PathBuf::from("/");
    for component in path.as_ref().components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::ParentDir => {
                out.pop();
            }
            _ => {}
        }
    }
    out
}

fn globs(patterns: &[String]) -> Result<GlobSet, JsError> {
    let mut set = GlobSetBuilder::new();
    for pattern in patterns {
        set.add(GlobBuilder::new(pattern).literal_separator(true).build()?);
    }
    Ok(set.build()?)
}

fn fs_error(err: FsError, path: &Path) -> JsError {
    JsError::new(&format!("{err}: '{}'", path.display()))
}
