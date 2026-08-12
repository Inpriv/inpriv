//! Background line indexing for the memory-mapped buffer.
//!
//! Produces a [`LineIndex`]: a `Vec<usize>` of byte offsets marking the *start*
//! of each line. Line `i` then spans
//! `bytes[line_starts[i] .. line_starts.get(i+1).copied().unwrap_or(len)]`
//! (clamped to the file length for the final line). This is strictly
//! **zero-copy** — the index records only offsets; the actual bytes stay in the
//! memory map and are sliced on demand by the renderer.
//!
//! Scanning uses [`memchr`] for SIMD-accelerated `\n` detection. The file is
//! processed in fixed-size blocks so that (a) progress can be reported between
//! blocks and (b) an in-flight index can be cancelled promptly between blocks.
//!
//! # Line-counting rule
//! A line start is recorded at byte `0` and after every `\n`, *except* a `\n`
//! that is the final byte of the file (that one merely terminates the last
//! line and does not start a phantom empty line). So `b"a\nb\n"` has 2 lines,
//! matching how editors display it. `line_starts.len()` is always the line
//! count (an empty file yields `vec![0]` → 1 empty line).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use memchr::memchr_iter;

/// Shared, thread-safe progress + cancellation state for an in-flight index job.
///
/// The UI thread reads [`Self::bytes_scanned`] / [`Self::total_bytes`] every
/// frame to render a progress bar, and sets [`Self::cancelled`] when the user
/// opens a different file or closes the buffer.
#[derive(Debug)]
pub struct IndexProgress {
    /// Number of file bytes scanned so far.
    pub bytes_scanned: AtomicU64,
    /// Total file size in bytes (denominator for the progress fraction).
    pub total_bytes: AtomicU64,
    /// Set by the caller to request cancellation. Polled between blocks.
    pub cancelled: AtomicBool,
}

impl IndexProgress {
    /// Create a fresh handle for a file of `total_bytes` bytes.
    pub fn new(total_bytes: u64) -> Self {
        Self {
            bytes_scanned: AtomicU64::new(0),
            total_bytes: AtomicU64::new(total_bytes),
            cancelled: AtomicBool::new(false),
        }
    }

    /// Current completion fraction in `0.0..=1.0`.
    ///
    /// `Relaxed` ordering is sufficient: this is a fuzzy readout for a progress
    /// bar, not a synchronization primitive.
    pub fn fraction(&self) -> f32 {
        let total = self.total_bytes.load(Ordering::Relaxed);
        if total == 0 {
            return 1.0;
        }
        let scanned = self.bytes_scanned.load(Ordering::Relaxed);
        ((scanned as f64 / total as f64).min(1.0)) as f32
    }

    /// Request cancellation of the indexing job.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }
}

/// The result of indexing a file: byte offset of every line start, plus the
/// wall-clock time the scan took (reported in the status bar).
///
/// `line_starts` always contains at least one entry (`0`), so
/// [`LineIndex::line_count`] is always `>= 1`.
#[derive(Debug)]
pub struct LineIndex {
    /// Byte offset of the first byte of each line. `line_starts[i]` is the
    /// start of line `i` (0-indexed). The end of line `i` is `line_starts[i+1]`
    /// or `bytes.len()` for the final line. Each non-final line's span includes
    /// its trailing `\n` (and `\r` for CRLF); the renderer is responsible for
    /// trimming line terminators for display.
    pub line_starts: Vec<usize>,
    /// Wall-clock milliseconds spent scanning. Reported in the status bar.
    pub index_time_ms: u128,
}

impl LineIndex {
    /// Number of lines (always `>= 1`).
    pub fn line_count(&self) -> usize {
        self.line_starts.len()
    }

    /// Byte span of line `i`, or `None` if out of range.
    pub fn span(&self, i: usize, total_len: usize) -> Option<(usize, usize)> {
        let starts = &self.line_starts;
        if i >= starts.len() {
            return None;
        }
        let start = starts[i];
        let end = starts.get(i + 1).copied().unwrap_or(total_len);
        Some((start, end))
    }
}

/// Block size for chunked scanning: 8 MiB.
///
/// Tuned to balance SIMD throughput (large enough that per-block overhead is
/// negligible) against progress/cancellation latency (~every few milliseconds
/// on a multi-GB/s memory read) and L2/L3 cache friendliness.
const BLOCK_BYTES: usize = 8 * 1024 * 1024;

/// Index every line start in `bytes`, reporting progress through `progress`.
///
/// Returns `None` if the job was cancelled before completion.
///
/// # Performance
/// Uses [`memchr`] (SIMD `\n` detection). Throughput is typically multi-GB/s,
/// so a 10 GB file indexes in a few seconds and rockyou (~140 MB, ~14 M lines)
/// in well under 100 ms.
///
/// # Memory
/// The index is `Vec<usize>` = ~8 bytes/line. rockyou's ~14 M lines cost
/// ~120 MB of index RAM — far less than copying content, and never touches the
/// file bytes themselves. For >100 M-line files a delta-varint encoding would
/// shrink this further; the [`LineIndex`] type is the seam for that swap.
pub fn index_lines(bytes: &[u8], progress: &IndexProgress) -> Option<LineIndex> {
    let start = Instant::now();
    let total_len = bytes.len();

    // Heuristic capacity: assume ~32 B average line length to avoid repeated
    // reallocs during the scan. We `shrink_to_fit` at the end, so an
    // over-estimate costs only transient RSS. For rockyou (avg line ~9 B) this
    // over-allocates ~3.5x transiently — acceptable.
    let mut line_starts: Vec<usize> = Vec::with_capacity(total_len / 32 + 1);

    // Line 0 always starts at byte 0 (also true for an empty file, so callers
    // can treat `line_starts.len()` as the line count).
    line_starts.push(0);

    let mut offset = 0usize;
    while offset < total_len {
        // Check cancellation at every block boundary for prompt abort.
        if progress.is_cancelled() {
            return None;
        }

        let end = (offset + BLOCK_BYTES).min(total_len);
        let block = &bytes[offset..end];

        // SIMD-accelerated newline scan within this block.
        for nl in memchr_iter(b'\n', block) {
            let abs = offset + nl;
            // A trailing newline at EOF does not start a new line — see the
            // module-level line-counting rule.
            if abs + 1 < total_len {
                line_starts.push(abs + 1);
            }
        }

        offset = end;
        progress.bytes_scanned.store(offset as u64, Ordering::Relaxed);
    }

    // Release any over-allocated headroom from the capacity heuristic.
    line_starts.shrink_to_fit();

    Some(LineIndex {
        line_starts,
        index_time_ms: start.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(data: &[u8]) -> LineIndex {
        let p = IndexProgress::new(data.len() as u64);
        index_lines(data, &p).unwrap()
    }

    fn line<'a>(data: &'a [u8], idx: &LineIndex, i: usize) -> &'a [u8] {
        let (start, end) = idx.span(i, data.len()).unwrap();
        &data[start..end]
    }

    #[test]
    fn empty_file_is_one_empty_line() {
        let idx = index(b"");
        assert_eq!(idx.line_starts, vec![0]);
        assert_eq!(idx.line_count(), 1);
    }

    #[test]
    fn single_line_without_newline() {
        let idx = index(b"hello");
        assert_eq!(idx.line_starts, vec![0]);
        assert_eq!(line(b"hello", &idx, 0), b"hello");
    }

    #[test]
    fn multiple_lines_preserve_spans() {
        let data = b"aaa\nbb\ncccc";
        let idx = index(data);
        assert_eq!(idx.line_starts, vec![0, 4, 7]);
        assert_eq!(line(data, &idx, 0), b"aaa\n");
        assert_eq!(line(data, &idx, 1), b"bb\n");
        assert_eq!(line(data, &idx, 2), b"cccc");
        assert_eq!(idx.line_count(), 3);
    }

    #[test]
    fn trailing_newline_does_not_create_phantom_line() {
        let data = b"a\nb\n";
        let idx = index(data);
        assert_eq!(idx.line_starts, vec![0, 2]);
        assert_eq!(idx.line_count(), 2);
        assert_eq!(line(data, &idx, 1), b"b\n");
    }

    #[test]
    fn lone_newline_is_one_empty_line() {
        // A file containing only "\n": one line whose span is the newline.
        let idx = index(b"\n");
        assert_eq!(idx.line_starts, vec![0]);
        assert_eq!(line(b"\n", &idx, 0), b"\n");
    }

    #[test]
    fn cancellation_aborts_before_first_block() {
        let data = vec![b'a'; BLOCK_BYTES * 2]; // spans two blocks
        let p = IndexProgress::new(data.len() as u64);
        p.cancel();
        assert!(index_lines(&data, &p).is_none());
    }

    #[test]
    fn block_boundary_newlines_indexed_correctly() {
        // Span more than one block; place newlines at the very end of block 0
        // and the very start of block 1 to exercise the chunked scan seam.
        let mut data = vec![b'x'; BLOCK_BYTES + 10];
        data[BLOCK_BYTES - 1] = b'\n'; // last byte of block 0
        data[BLOCK_BYTES] = b'\n'; // first byte of block 1
        let idx = index(&data);
        assert_eq!(
            idx.line_starts,
            vec![0, BLOCK_BYTES, BLOCK_BYTES + 1]
        );
    }

    #[test]
    fn span_out_of_range_is_none() {
        let idx = index(b"a\nb");
        assert_eq!(idx.span(0, 3), Some((0, 2)));
        assert_eq!(idx.span(1, 3), Some((2, 3)));
        assert_eq!(idx.span(2, 3), None);
    }
}
