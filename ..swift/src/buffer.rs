//! Memory-mapped buffer: maps a file read-only into virtual address space and
//! indexes its lines on a background thread.
//!
//! The mapped bytes are **never copied into the heap**. Rendering reads line
//! slices directly from the map via [`Buffer::bytes`] / [`Buffer::line`]. The
//! line index (`Vec<usize>`) is the only allocation that scales with file size.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use memmap2::Mmap;

use crate::indexer::{index_lines, IndexProgress, LineIndex};

/// Lifecycle of a [`Buffer`].
///
/// Note: does not derive `Eq` because [`BufferState::Indexing`] carries an
/// `f32` progress value, which is not `Eq` (and only fuzzily `PartialEq`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BufferState {
    /// No file loaded.
    Empty,
    /// Lines are being indexed in the background; the value is progress in
    /// `0.0..=1.0`.
    Indexing(f32),
    /// Indexing complete; the buffer is ready to render.
    Ready,
    /// Opening or indexing failed (e.g. the file was unmappable, or the index
    /// job was cancelled).
    Failed,
}

/// Outcome of a background indexing job, shared between the worker and the UI
/// thread through a `Mutex`.
enum IndexOutcome {
    /// Still running.
    Pending,
    /// Finished successfully.
    Ready(LineIndex),
    /// Finished but was cancelled (e.g. the user opened another file).
    Cancelled,
}

/// A live indexing job: the channels the UI thread uses to monitor and cancel
/// it. The worker thread is detached (never joined) — see [`Buffer::open`].
struct IndexJob {
    progress: Arc<IndexProgress>,
    outcome: Arc<Mutex<IndexOutcome>>,
}

/// The backing byte store for a [`Buffer`].
enum Backing {
    /// A read-only memory map of the file.
    Map(Arc<Mmap>),
    /// An empty file (0 bytes cannot be mapped on most platforms). The single
    /// empty line is represented directly.
    Empty,
}

/// Errors that can occur while opening or mapping a file.
#[derive(Debug)]
pub enum BufferError {
    /// The file could not be opened (missing, permission denied, ...).
    OpenFailed(io::Error),
    /// The file could not be memory-mapped (locked, I/O error, ...).
    MapFailed(io::Error),
}

impl std::fmt::Display for BufferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BufferError::OpenFailed(e) => write!(f, "failed to open file: {e}"),
            BufferError::MapFailed(e) => write!(f, "failed to memory-map file: {e}"),
        }
    }
}

impl std::error::Error for BufferError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            BufferError::OpenFailed(e) | BufferError::MapFailed(e) => Some(e),
        }
    }
}

/// A zero-copy, memory-mapped view of a text file with a background line index.
///
/// Renderers borrow `&[u8]` slices via [`Buffer::bytes`] / [`Buffer::line`]; no
/// line content is ever heap-allocated. Call [`Buffer::poll_indexing`] once per
/// UI frame to advance the lifecycle and pick up the finished index.
pub struct Buffer {
    /// Underlying byte store (`None` while empty/unloaded).
    backing: Option<Backing>,
    /// The completed line index, present once [`BufferState::Ready`].
    index: Option<Arc<LineIndex>>,
    /// The active background job, if currently [`BufferState::Indexing`].
    job: Option<IndexJob>,
    state: BufferState,
    path: Option<PathBuf>,
    size_bytes: u64,
    total_lines: usize,
}

impl Default for Buffer {
    fn default() -> Self {
        Self::new()
    }
}

impl Buffer {
    /// Create an empty buffer.
    pub fn new() -> Self {
        Self {
            backing: None,
            index: None,
            job: None,
            state: BufferState::Empty,
            path: None,
            size_bytes: 0,
            total_lines: 0,
        }
    }

    /// Current lifecycle state.
    pub fn state(&self) -> BufferState {
        self.state
    }

    /// Loaded file path, if any.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// File size in bytes.
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }

    /// Total line count (valid once [`BufferState::Ready`]).
    pub fn total_lines(&self) -> usize {
        self.total_lines
    }

    /// Time spent indexing, in milliseconds (valid once [`BufferState::Ready`]).
    pub fn index_time_ms(&self) -> Option<u128> {
        self.index.as_ref().map(|i| i.index_time_ms)
    }

    /// Shared handle to the line index, if ready. Cloning the `Arc` is cheap
    /// and lets a background search thread outlive any single UI borrow.
    pub fn index_ref(&self) -> Option<&Arc<LineIndex>> {
        self.index.as_ref()
    }

    /// Shared handle to the underlying memory map, if any. Used by background
    /// search to read bytes without going through the UI-thread borrow.
    pub fn mmap_arc(&self) -> Option<&Arc<Mmap>> {
        match self.backing.as_ref()? {
            Backing::Map(m) => Some(m),
            Backing::Empty => None,
        }
    }

    /// The full mapped byte slice, zero-copy. Available as soon as the file is
    /// mapped (during indexing and after), even before the index is ready.
    pub fn bytes(&self) -> Option<&[u8]> {
        match self.backing.as_ref()? {
            Backing::Map(m) => Some(&m[..]),
            Backing::Empty => Some(&[]),
        }
    }

    /// Byte span of line `i`, zero-copy. Returns `None` if out of range or the
    /// index is not ready yet.
    ///
    /// The returned slice includes the line's trailing `\n` (and `\r` for
    /// CRLF); trim it in the renderer for display.
    pub fn line(&self, i: usize) -> Option<&[u8]> {
        let index = self.index.as_ref()?;
        let bytes = self.bytes()?;
        let (start, end) = index.span(i, bytes.len())?;
        Some(&bytes[start..end])
    }

    /// Open and map `path`, then start background line indexing.
    ///
    /// All fallible work (open / metadata / mmap) happens **before** `self` is
    /// mutated, so a failure leaves the currently-open file fully intact. On
    /// success any in-flight indexer is cancelled and the new state is
    /// committed atomically. Indexing completes asynchronously and is surfaced
    /// via [`Buffer::poll_indexing`].
    pub fn open<P: Into<PathBuf>>(&mut self, path: P) -> Result<(), BufferError> {
        let path = path.into();

        // --- Validate + build into locals; do NOT touch self yet. ---
        let file = File::open(&path).map_err(BufferError::OpenFailed)?;
        let size_bytes = file
            .metadata()
            .map_err(BufferError::OpenFailed)?
            .len();

        let (backing, index, job, state, total_lines) = if size_bytes == 0 {
            // Empty files cannot be mapped on most platforms; represent as a
            // single empty line that is ready immediately.
            (
                Backing::Empty,
                Some(Arc::new(LineIndex {
                    line_starts: vec![0],
                    index_time_ms: 0,
                })),
                None,
                BufferState::Ready,
                1,
            )
        } else {
            // SAFETY: `file` is opened read-only and we never mutate it through
            // the map. Read-only viewing of static text/log data is the
            // standard, accepted pattern for this kind of viewer.
            let mmap = unsafe { Mmap::map(&file) }.map_err(BufferError::MapFailed)?;
            // The mapping outlives the file handle on both Unix (POSIX keeps a
            // mapping valid after close(2)) and Windows (the mapping object
            // holds its own reference), so the handle may be released here.
            drop(file);
            let mmap = Arc::new(mmap);

            let progress = Arc::new(IndexProgress::new(size_bytes));
            let outcome = Arc::new(Mutex::new(IndexOutcome::Pending));

            // Background indexer. Owns its own `Arc` clones and is detached
            // (never joined — joining would block the UI thread). It writes the
            // outcome exactly once on completion or cancellation.
            {
                let worker_mmap = mmap.clone();
                let worker_progress = progress.clone();
                let worker_outcome = outcome.clone();
                thread::spawn(move || {
                    let bytes: &[u8] = &worker_mmap[..];
                    let result = index_lines(bytes, &worker_progress);
                    let next = match result {
                        Some(idx) => IndexOutcome::Ready(idx),
                        None => IndexOutcome::Cancelled,
                    };
                    if let Ok(mut guard) = worker_outcome.lock() {
                        *guard = next;
                    }
                });
            }

            (
                Backing::Map(mmap),
                None,
                Some(IndexJob { progress, outcome }),
                BufferState::Indexing(0.0),
                0,
            )
        };

        // --- Commit: every fallible step succeeded. ---
        self.cancel_inflight();
        self.backing = Some(backing);
        self.index = index;
        self.job = job;
        self.state = state;
        self.path = Some(path);
        self.size_bytes = size_bytes;
        self.total_lines = total_lines;
        Ok(())
    }

    /// Advance the lifecycle by polling the background indexer. Call once per
    /// UI frame. Cheap when idle (no job) or still indexing (one atomic read +
    /// a brief lock).
    pub fn poll_indexing(&mut self) {
        // Read everything we need from the job under a shared borrow, then drop
        // the borrow before mutating `self`.
        let (fraction, outcome) = match self.job.as_ref() {
            None => return,
            Some(job) => {
                let outcome = {
                    let mut guard = job.outcome.lock().unwrap();
                    // Take ownership of the outcome, resetting the slot. For the
                    // `Pending` case this is a no-op (Pending <- Pending).
                    std::mem::replace(&mut *guard, IndexOutcome::Pending)
                };
                (job.progress.fraction(), outcome)
            }
        };

        match outcome {
            IndexOutcome::Pending => {
                self.state = BufferState::Indexing(fraction);
            }
            IndexOutcome::Ready(idx) => {
                self.total_lines = idx.line_count();
                self.index = Some(Arc::new(idx));
                self.job = None;
                self.state = BufferState::Ready;
            }
            IndexOutcome::Cancelled => {
                self.job = None;
                self.state = BufferState::Failed;
            }
        }
    }

    /// Close the current file and reset to [`BufferState::Empty`]. Cancels any
    /// in-flight indexer.
    pub fn close(&mut self) {
        self.cancel_inflight();
        self.backing = None;
        self.index = None;
        self.job = None;
        self.state = BufferState::Empty;
        self.path = None;
        self.size_bytes = 0;
        self.total_lines = 0;
    }

    /// Request cancellation of any in-flight indexer and drop our handle to it.
    /// The detached worker keeps its own `Arc` clones alive until it observes
    /// the cancellation and exits.
    fn cancel_inflight(&mut self) {
        if let Some(job) = self.job.take() {
            job.progress.cancel();
        }
    }
}

impl Drop for Buffer {
    fn drop(&mut self) {
        // Ensure an in-flight worker is told to stop before we go. Its `Arc`
        // clones (map + progress) keep the relevant memory valid until it
        // finishes, so detaching is safe.
        self.cancel_inflight();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write `contents` to a unique temp file and return its path.
    fn tmp_file(contents: &[u8]) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!(
            "inpriv-swift-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let mut f = std::fs::File::create(&dir).unwrap();
        f.write_all(contents).unwrap();
        dir
    }

    /// Poll `buf` until it reaches a non-Indexing state.
    fn drain(buf: &mut Buffer) {
        let guard = 0..100_000;
        for _ in guard {
            buf.poll_indexing();
            if !matches!(buf.state(), BufferState::Indexing(_)) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("buffer never left Indexing state");
    }

    #[test]
    fn new_buffer_is_empty() {
        let b = Buffer::new();
        assert_eq!(b.state(), BufferState::Empty);
        assert_eq!(b.bytes(), None);
        assert_eq!(b.line(0), None);
        assert_eq!(b.total_lines(), 0);
    }

    #[test]
    fn open_and_index_small_file() {
        let path = tmp_file(b"alpha\nbeta\ngamma\n");
        let mut b = Buffer::new();
        b.open(&path).unwrap();
        drain(&mut b);
        assert_eq!(b.state(), BufferState::Ready);
        assert_eq!(b.total_lines(), 3);
        assert_eq!(b.line(0).unwrap(), b"alpha\n");
        assert_eq!(b.line(1).unwrap(), b"beta\n");
        assert_eq!(b.line(2).unwrap(), b"gamma\n");
        assert_eq!(b.line(3), None);
    }

    #[test]
    fn empty_file_maps_to_single_empty_line() {
        let path = tmp_file(b"");
        let mut b = Buffer::new();
        b.open(&path).unwrap();
        // Empty files complete synchronously (no worker spawned).
        assert_eq!(b.state(), BufferState::Ready);
        assert_eq!(b.total_lines(), 1);
        assert_eq!(b.bytes().unwrap(), b"");
        assert_eq!(b.line(0).unwrap(), b"");
    }

    #[test]
    fn close_resets_state() {
        let path = tmp_file(b"x\ny\n");
        let mut b = Buffer::new();
        b.open(&path).unwrap();
        drain(&mut b);
        assert_eq!(b.state(), BufferState::Ready);
        b.close();
        assert_eq!(b.state(), BufferState::Empty);
        assert_eq!(b.bytes(), None);
        assert_eq!(b.path(), None);
    }

    #[test]
    fn reopen_cancels_prior_job() {
        let p1 = tmp_file(b"one\n");
        let p2 = tmp_file(b"two\nthree\n");
        let mut b = Buffer::new();
        b.open(&p1).unwrap();
        // Immediately open a second file; the first job must be cancelled and
        // replaced without deadlock.
        b.open(&p2).unwrap();
        drain(&mut b);
        assert_eq!(b.state(), BufferState::Ready);
        assert_eq!(b.total_lines(), 2);
        assert_eq!(b.line(0).unwrap(), b"two\n");
        assert_eq!(b.line(1).unwrap(), b"three\n");
    }

    #[test]
    fn missing_file_returns_open_failed() {
        let mut b = Buffer::new();
        let err = b.open("/definitely/does/not/exist/xyz").unwrap_err();
        assert!(matches!(err, BufferError::OpenFailed(_)));
    }
}
