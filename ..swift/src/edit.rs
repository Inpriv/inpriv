//! Optional editing overlay for the zero-copy buffer.
//!
//! Design: the file itself is **never mutated in place and never copied into
//! RAM**. Edits live in a [`BTreeMap`] keyed by *original* line index, holding
//! only the lines the user actually touched. Rendering resolves a *logical*
//! (post-edit) line number through the map in `O(number of edited lines)` —
//! independent of file size — and the untouched path stays a plain mmap slice
//! read. This is a line-granular piece table: browsing a 10 GB file with three
//! edits costs the same as browsing it read-only.
//!
//! Saving streams the merged content (original byte slices + edited strings)
//! through a buffered writer into a temp file, then swaps it in and reopens the
//! buffer, so peak extra memory is one edit map, not one file.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::path::Path;

use crate::indexer::LineIndex;

/// What happens to one original line.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Kind {
    /// No change; the entry exists only to carry `insert_before` lines.
    #[default]
    Keep,
    /// Replace the line's content (terminator excluded).
    Replace(String),
    /// Remove the line.
    Delete,
}

/// All edits anchored at one original line index.
#[derive(Debug, Clone, Default)]
pub struct LineEdit {
    /// Lines inserted immediately *before* the original line.
    pub insert_before: Vec<String>,
    /// The edit applied to the original line itself.
    pub kind: Kind,
}

impl LineEdit {
    fn is_empty(&self) -> bool {
        matches!(self.kind, Kind::Keep) && self.insert_before.is_empty()
    }
}

/// Where the content of one *logical* (post-edit) line comes from.
#[derive(Clone, Copy, Debug)]
pub enum LineView<'a> {
    /// Unmodified: render zero-copy from the mmap. Carries the ORIGINAL index.
    Original(usize),
    /// Edited or inserted content.
    Edited(&'a str),
}

/// Internal result of the mapping walk: where a logical line physically lives.
#[derive(Debug)]
enum Slot<'a> {
    /// An unmodified original line.
    Orig { line: usize },
    /// A replaced original line (key = original index).
    Replaced { key: usize, text: &'a str },
    /// A line inside the `insert_before` vec of `key` at position `idx`.
    Inserted { key: usize, idx: usize, text: &'a str },
}

/// Line-granular edit overlay on top of a read-only buffer.
///
/// All indices handed in and out of the public mapping helpers are *logical*
/// (what the user sees) unless explicitly named `original*`.
#[derive(Debug, Default)]
pub struct Edits {
    map: BTreeMap<usize, LineEdit>,
}

impl Edits {
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }

    /// Number of logical lines after applying the edits to a file with
    /// `original_total` lines.
    pub fn total_lines(&self, original_total: usize) -> usize {
        let mut n = original_total as i64;
        for e in self.map.values() {
            n += e.insert_before.len() as i64;
            if matches!(e.kind, Kind::Delete) {
                n -= 1;
            }
        }
        n.max(0) as usize
    }

    /// Resolve logical line `logical` to its content source.
    ///
    /// `O(edits)` per call; with no edits this is the trivial identity fast
    /// path the renderer uses. Callers must pass `logical < total_lines()`.
    pub fn view(&self, original_total: usize, logical: usize) -> LineView<'_> {
        match self.locate(original_total, logical) {
            Some(Slot::Orig { line }) => LineView::Original(line),
            Some(Slot::Replaced { text, .. } | Slot::Inserted { text, .. }) => {
                LineView::Edited(text)
            }
            None => LineView::Original(logical),
        }
    }

    /// Set the content of logical line `logical` (creating a `Replace` edit if
    /// it was still an untouched original line).
    pub fn set_line(&mut self, original_total: usize, logical: usize, text: String) {
        match self.locate(original_total, logical) {
            Some(Slot::Orig { line } | Slot::Replaced { key: line, .. }) => {
                self.map.entry(line).or_default().kind = Kind::Replace(text);
            }
            Some(Slot::Inserted { key, idx, .. }) => {
                if let Some(e) = self.map.get_mut(&key) {
                    if idx < e.insert_before.len() {
                        e.insert_before[idx] = text;
                    }
                }
            }
            None => {}
        }
    }

    /// Remove logical line `logical`.
    pub fn delete_line(&mut self, original_total: usize, logical: usize) {
        match self.locate(original_total, logical) {
            Some(Slot::Orig { line } | Slot::Replaced { key: line, .. }) => {
                self.map.entry(line).or_default().kind = Kind::Delete;
            }
            Some(Slot::Inserted { key, idx, .. }) => {
                if let Some(e) = self.map.get_mut(&key) {
                    if idx < e.insert_before.len() {
                        e.insert_before.remove(idx);
                    }
                    if e.is_empty() {
                        self.map.remove(&key);
                    }
                }
            }
            None => {}
        }
    }

    /// Insert `text` as a new logical line directly after `logical`.
    pub fn insert_after(&mut self, original_total: usize, logical: usize, text: String) {
        match self.locate(original_total, logical) {
            Some(Slot::Orig { line } | Slot::Replaced { key: line, .. }) => {
                // `line + 1` may equal `original_total` (append at EOF); the
                // walk treats an entry keyed there as a pure append anchor.
                self.map.entry(line + 1).or_default().insert_before.push(text);
            }
            Some(Slot::Inserted { key, idx, .. }) => {
                if let Some(e) = self.map.get_mut(&key) {
                    let at = (idx + 1).min(e.insert_before.len());
                    e.insert_before.insert(at, text);
                }
            }
            None => {}
        }
    }

    /// Map an original line index to its logical index after edits.
    /// Returns `None` if that original line was deleted. `O(edits)`.
    pub fn logical_of_original(&self, original_total: usize, original: usize) -> Option<usize> {
        if original >= original_total {
            return None;
        }
        let mut orig = 0usize;
        let mut lg = 0usize;
        for (&key, entry) in &self.map {
            if original < key {
                return Some(lg + (original - orig));
            }
            lg += key - orig;
            orig = key;
            lg += entry.insert_before.len();
            match entry.kind {
                Kind::Delete => {}
                Kind::Replace(_) | Kind::Keep => {
                    if orig == original {
                        return Some(lg);
                    }
                    lg += 1;
                }
            }
            orig = key + 1;
        }
        original
            .checked_sub(orig)
            .map(|d| lg + d)
            .filter(|&l| l < self.total_lines(original_total))
    }

    /// Single mapping walk: finds where logical line `logical` lives.
    fn locate(&self, original_total: usize, logical: usize) -> Option<Slot<'_>> {
        let mut orig = 0usize; // next original line not yet accounted for
        let mut lg = 0usize; // logical index of the next thing we process
        for (&key, entry) in &self.map {
            // Unedited original run [orig, key). `key` may be `original_total`
            // (an append-at-EOF anchor), in which case the run is the tail.
            let run = (key - orig).min(original_total.saturating_sub(orig));
            if logical < lg + run {
                return Some(Slot::Orig {
                    line: orig + (logical - lg),
                });
            }
            lg += run;
            for (idx, text) in entry.insert_before.iter().enumerate() {
                if lg == logical {
                    return Some(Slot::Inserted { key, idx, text });
                }
                lg += 1;
            }
            match &entry.kind {
                Kind::Delete => {}
                Kind::Replace(text) => {
                    if lg == logical {
                        return Some(Slot::Replaced { key, text });
                    }
                    lg += 1;
                }
                Kind::Keep => {
                    if lg == logical {
                        return Some(Slot::Orig { line: key });
                    }
                    lg += 1;
                }
            }
            orig = key + 1;
        }
        let tail = original_total.saturating_sub(orig);
        if logical < lg + tail {
            Some(Slot::Orig {
                line: orig + (logical - lg),
            })
        } else {
            None
        }
    }
}

/// Strip trailing `\n` / `\r` bytes from a raw line slice.
pub fn trim_eol(mut s: &[u8]) -> &[u8] {
    loop {
        match s.split_last() {
            Some((b'\n', rest)) | Some((b'\r', rest)) => s = rest,
            _ => return s,
        }
    }
}

/// Whether the file's first line ends with CRLF (drives the save terminator).
fn is_crlf(bytes: &[u8]) -> bool {
    match memchr::memchr(b'\n', bytes) {
        Some(i) => i > 0 && bytes[i - 1] == b'\r',
        None => false,
    }
}

/// Stream the post-edit content to `path`: original lines are copied straight
/// from the mmap slice, edited/inserted lines from the overlay.
///
/// Every line is written with a terminator (`\n`, or `\r\n` when the original
/// file uses CRLF), including the last. Returns the bytes written.
pub fn write_file(
    edits: &Edits,
    original: &[u8],
    index: &LineIndex,
    path: &Path,
) -> io::Result<u64> {
    let term: &[u8] = if is_crlf(original) { b"\r\n" } else { b"\n" };
    let total = index.line_count();
    let file = File::create(path)?;
    let mut w = BufWriter::with_capacity(1 << 20, file);
    let mut wrote = 0u64;

    let mut orig = 0usize;
    for (&key, entry) in &edits.map {
        for i in orig..key.min(total) {
            wrote += write_original(&mut w, original, index, i, term)?;
        }
        for line in &entry.insert_before {
            w.write_all(line.as_bytes())?;
            w.write_all(term)?;
            wrote += line.len() as u64 + term.len() as u64;
        }
        match &entry.kind {
            Kind::Delete => {}
            Kind::Replace(text) => {
                w.write_all(text.as_bytes())?;
                w.write_all(term)?;
                wrote += text.len() as u64 + term.len() as u64;
            }
            // A `Keep` at key == total is an append anchor, not a real line.
            Kind::Keep if key >= total => {}
            Kind::Keep => {
                wrote += write_original(&mut w, original, index, key, term)?;
            }
        }
        orig = key + 1;
    }
    for i in orig..total {
        wrote += write_original(&mut w, original, index, i, term)?;
    }

    w.flush()?;
    // Sync so the swap-in that follows isn't racing the OS page cache.
    w.into_inner()?.sync_all()?;
    Ok(wrote)
}

/// Copy one original line (terminator trimmed) plus a fresh terminator.
fn write_original<W: Write>(
    w: &mut W,
    bytes: &[u8],
    index: &LineIndex,
    i: usize,
    term: &[u8],
) -> io::Result<u64> {
    let (s, e) = index.span(i, bytes.len()).unwrap_or((0, 0));
    let line = trim_eol(&bytes[s..e]);
    w.write_all(line)?;
    w.write_all(term)?;
    Ok(line.len() as u64 + term.len() as u64)
}

/// UI-level editing state: mode flag, the inline editor's target/draft, and
/// the dirty bit that drives the save affordances.
#[derive(Default)]
pub struct EditState {
    /// Whether edit mode is on (the optional toggle; off by default).
    pub enabled: bool,
    /// The edit overlay itself.
    pub edits: Edits,
    /// Logical line currently being edited (inline editor shown there).
    pub editing_line: Option<usize>,
    /// Draft text for the inline editor.
    pub draft: String,
    /// Whether any edit is unsaved.
    pub modified: bool,
    /// Focus the inline editor on the next frame.
    pub focus_requested: bool,
    /// Set when an edit changed line numbering; retriggers a search rescan.
    pub search_stale: bool,
    /// Set when the user tried to leave edit mode with unsaved changes.
    pub confirm_discard: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::indexer::{index_lines, IndexProgress};

    fn idx(data: &[u8]) -> LineIndex {
        index_lines(data, &IndexProgress::new(data.len() as u64)).unwrap()
    }

    fn s(v: &Edits, total: usize, logical: usize) -> String {
        match v.view(total, logical) {
            LineView::Original(_) => panic!("expected edited"),
            LineView::Edited(t) => t.to_string(),
        }
    }

    fn orig(v: &Edits, total: usize, logical: usize) -> usize {
        match v.view(total, logical) {
            LineView::Original(n) => n,
            LineView::Edited(_) => panic!("expected original"),
        }
    }

    #[test]
    fn no_edits_is_identity() {
        let v = Edits::default();
        assert_eq!(v.total_lines(7), 7);
        assert_eq!(orig(&v, 7, 0), 0);
        assert_eq!(orig(&v, 7, 6), 6);
    }

    #[test]
    fn replace_maps_in_place() {
        let mut v = Edits::default();
        v.set_line(3, 1, "x".into());
        assert_eq!(v.total_lines(3), 3);
        assert_eq!(orig(&v, 3, 0), 0);
        assert_eq!(s(&v, 3, 1), "x");
        assert_eq!(orig(&v, 3, 2), 2);
        assert_eq!(v.logical_of_original(3, 1), Some(1));
    }

    #[test]
    fn delete_shifts_logical_numbers() {
        let mut v = Edits::default();
        v.delete_line(3, 0);
        assert_eq!(v.total_lines(3), 2);
        assert_eq!(orig(&v, 3, 0), 1);
        assert_eq!(orig(&v, 3, 1), 2);
        assert_eq!(v.logical_of_original(3, 0), None);
        assert_eq!(v.logical_of_original(3, 1), Some(0));
    }

    #[test]
    fn insert_in_middle() {
        let mut v = Edits::default();
        v.insert_after(3, 0, "new".into());
        assert_eq!(v.total_lines(3), 4);
        assert_eq!(orig(&v, 3, 0), 0);
        assert_eq!(s(&v, 3, 1), "new");
        assert_eq!(orig(&v, 3, 2), 1);
    }

    #[test]
    fn insert_at_end_appends() {
        let mut v = Edits::default();
        v.insert_after(3, 2, "tail".into());
        assert_eq!(v.total_lines(3), 4);
        assert_eq!(orig(&v, 3, 2), 2);
        assert_eq!(s(&v, 3, 3), "tail");
    }

    #[test]
    fn edit_an_inserted_line() {
        let mut v = Edits::default();
        v.insert_after(2, 0, "a".into());
        v.insert_after(2, 1, "b".into()); // after the inserted line
        v.set_line(2, 1, "A!".into()); // edit the first inserted line
        assert_eq!(v.total_lines(2), 4);
        assert_eq!(orig(&v, 2, 0), 0);
        assert_eq!(s(&v, 2, 1), "A!");
        assert_eq!(s(&v, 2, 2), "b");
        assert_eq!(orig(&v, 2, 3), 1);
    }

    #[test]
    fn delete_an_inserted_line_restores_layout() {
        let mut v = Edits::default();
        v.insert_after(2, 0, "a".into());
        v.delete_line(2, 1);
        assert!(v.is_empty());
        assert_eq!(v.total_lines(2), 2);
        assert_eq!(orig(&v, 2, 0), 0);
    }

    #[test]
    fn delete_original_keeps_its_insert_before() {
        let mut v = Edits::default();
        v.insert_after(2, 0, "a".into()); // anchored before original line 1
        v.delete_line(2, 2); // delete original line 1 (now at logical 2)
        assert_eq!(v.total_lines(2), 2);
        assert_eq!(orig(&v, 2, 0), 0);
        assert_eq!(s(&v, 2, 1), "a");
    }

    fn roundtrip(data: &[u8], v: &Edits) -> String {
        let index = idx(data);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "inpriv-swift-edit-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        write_file(v, data, &index, &path).unwrap();
        let out = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).ok();
        out
    }

    #[test]
    fn write_unedited_normalizes_trailing_newline() {
        let v = Edits::default();
        assert_eq!(roundtrip(b"a\nb", &v), "a\nb\n");
    }

    #[test]
    fn write_complex_overlay() {
        let data = b"l0\nl1\nl2\nl3";
        let mut v = Edits::default();
        v.set_line(4, 1, "ONE".into()); // replace l1
        v.delete_line(4, 2); // delete l2
        v.insert_after(4, 0, "after0".into()); // between l0 and ONE
        v.insert_after(4, 3, "tail".into()); // append at end
        assert_eq!(
            roundtrip(data, &v),
            "l0\nafter0\nONE\nl3\ntail\n"
        );
    }

    #[test]
    fn write_preserves_crlf() {
        let data = b"a\r\nb\r\n";
        let mut v = Edits::default();
        v.set_line(2, 1, "B".into());
        assert_eq!(roundtrip(data, &v), "a\r\nB\r\n");
    }

    #[test]
    fn write_empty_file_with_content() {
        // An empty buffer is one empty line; replacing it writes real content.
        let mut v = Edits::default();
        v.set_line(1, 0, "hello".into());
        assert_eq!(roundtrip(b"", &v), "hello\n");
    }

    #[test]
    fn trim_eol_strips_terminators() {
        assert_eq!(trim_eol(b"abc\r\n"), b"abc");
        assert_eq!(trim_eol(b"abc\n"), b"abc");
        assert_eq!(trim_eol(b"abc"), b"abc");
        assert_eq!(trim_eol(b""), b"");
    }
}
