//! Safe forced termination of workers.
//!
//! All workers share the engine's linear memory, and with it the global allocator
//! and the filesystem lock. `Worker.terminate()` stops a worker wherever it is, so a
//! worker killed while holding either lock would deadlock every other thread.
//!
//! Each worker therefore owns a [`Gate`] in shared memory which counts how deep it
//! currently is inside such critical sections. To kill a worker, the main thread
//! [dooms](Gate::doom) it, waits until it is [idle](Gate::is_idle) and only then
//! terminates it. A doomed worker parks forever (holding nothing) the next time it
//! tries to enter a critical section. This approach is borrowed from `wasmer-sdk`.
//!
//! Parking blocks rather than spins, since some runtimes (Bun) cannot terminate a
//! worker which is busy running WebAssembly.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicU32, Ordering::SeqCst};

#[derive(Default)]
pub struct Gate {
    depth: AtomicU32,
    doomed: AtomicU32,
}

impl Gate {
    /// Allocates a gate for a new worker. Gates are never freed, since a terminated
    /// worker may still be parked on its gate.
    pub fn leak() -> &'static Gate {
        Box::leak(Box::default())
    }

    pub fn doom(&self) {
        self.doomed.store(1, SeqCst);
    }

    /// Whether the worker is outside of every critical section. Once a doomed worker
    /// is idle, it remains idle.
    pub fn is_idle(&self) -> bool {
        self.depth.load(SeqCst) == 0
    }
}

/// The current worker's gate. This is a raw `#[thread_local]`, since `thread_local!`
/// cannot be accessed while a starting worker allocates its TLS block.
#[thread_local]
static CURRENT: Cell<Option<&'static Gate>> = Cell::new(None);

/// A static, whose address separates uninitialized TLS from worker TLS.
static ANCHOR: u8 = 0;

/// Installs `gate` as the gate of the current worker thread.
pub fn install(gate: &'static Gate) {
    CURRENT.set(Some(gate));
}

/// Marks the current thread as inside a critical section until dropped.
pub struct Critical(Option<&'static Gate>);

impl Critical {
    #[inline]
    pub fn enter() -> Self {
        // Before a starting worker sets up its TLS block, thread locals resolve to low
        // addresses (below all statics), whereas worker TLS blocks live on the heap.
        let initialized = &raw const CURRENT as usize > &raw const ANCHOR as usize;
        let gate = if initialized { CURRENT.get() } else { None };
        if let Some(gate) = gate {
            // Pairs with `doom` + `is_idle`: either the main thread observes this
            // increment, or this thread observes the doom.
            if gate.depth.fetch_add(1, SeqCst) == 0 && gate.doomed.load(SeqCst) != 0 {
                gate.depth.fetch_sub(1, SeqCst);
                // Park (without spinning) until terminated: `doomed` is never reset.
                let doomed = gate.doomed.as_ptr() as *mut i32;
                loop {
                    unsafe { core::arch::wasm32::memory_atomic_wait32(doomed, 1, -1) };
                }
            }
        }
        Self(gate)
    }
}

impl Drop for Critical {
    #[inline]
    fn drop(&mut self) {
        if let Some(gate) = self.0 {
            gate.depth.fetch_sub(1, SeqCst);
        }
    }
}

/// The system allocator, with every call treated as a critical section.
struct GatedAllocator;

unsafe impl GlobalAlloc for GatedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _critical = Critical::enter();
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let _critical = Critical::enter();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _critical = Critical::enter();
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _critical = Critical::enter();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: GatedAllocator = GatedAllocator;
