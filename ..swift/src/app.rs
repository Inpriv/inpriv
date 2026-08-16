//! Application state and the [`eframe::App`] implementation.
//!
//! Owns the [`Buffer`], scroll position, search state, and bridges background
//! file-dialog results onto the UI thread. Per frame it polls the buffer's
//! indexer, then hands control to [`crate::ui::root`] for layout.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use eframe::egui;
use eframe::egui::{Context, FontDefinitions, FontFamily, Key, Modifiers};
use memmap2::Mmap;

use crate::buffer::{Buffer, BufferState};
use crate::edit::{self, EditState, LineView};
use crate::indexer::LineIndex;
use crate::ui;

const SHORTCUT_MOD: Modifiers = Modifiers::CTRL;

/// The eframe app, created once at startup and owned by the window.
pub struct App {
    /// The open file (or `Empty`).
    pub buffer: Buffer,
    /// Visible scroll position, updated each frame by the renderer.
    pub scroll_state: ScrollState,
    /// Search bar + result set.
    pub search: SearchState,
    /// Path chosen by a background file dialog, polled next frame.
    pending_path_slot: Option<Arc<Mutex<Option<PathBuf>>>>,
    /// Whether the OS reports a file currently dragged over the window.
    pub is_drag_hovered: bool,
    /// A user-facing error to show once (taken and cleared by the UI).
    error_banner: Option<String>,
    /// Optional edit mode: line-granular overlay on the read-only mmap.
    pub edit: EditState,
    /// Scratch buffer for lossy UTF-8 decoding of the current line.
    pub(crate) decode_scratch: String,
    /// GPU texture for the brand icon (shown top-left). `None` if decoding
    /// failed; the UI falls back to a vector mark in that case.
    icon_texture: Option<egui::TextureHandle>,
}

#[derive(Default)]
pub struct ScrollState {
    /// Line index currently at the top of the viewport (read-only mirror,
    /// written by the renderer each frame; do not set to scroll).
    pub top_line: usize,
    /// When `Some(line)`, the renderer scrolls that line into view next frame
    /// and clears this. This is the only correct way to drive the ScrollArea.
    pub scroll_to_line: Option<usize>,
}

/// One search hit: line index + byte offset within the line.
#[derive(Clone, Copy, Debug)]
pub struct SearchHit {
    pub line: usize,
    /// Byte offset of the match start within the line's span.
    #[allow(dead_code)]
    pub byte: usize,
}

pub struct SearchState {
    pub open: bool,
    pub query: String,
    pub matches: Vec<SearchHit>,
    pub current: usize,
    pub focus_requested: bool,
    dirty: bool,
    last_query: String,
    /// Background search result slot.
    search_result: Arc<Mutex<Option<Vec<SearchHit>>>>,
    /// Cancellation flag for an in-flight search.
    search_cancel: Arc<AtomicBool>,
}

impl Default for SearchState {
    fn default() -> Self {
        Self {
            open: false,
            query: String::new(),
            matches: Vec::new(),
            current: 0,
            focus_requested: false,
            dirty: false,
            last_query: String::new(),
            search_result: Arc::new(Mutex::new(None)),
            search_cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl SearchState {
    pub fn toggle(&mut self) {
        self.open = !self.open;
        if self.open {
            self.focus_requested = true;
        }
    }

    pub fn close(&mut self) {
        self.open = false;
        self.matches.clear();
        self.current = 0;
        self.query.clear();
        self.last_query.clear();
    }

    pub fn next(&mut self) {
        if self.matches.is_empty() {
            return;
        }
        self.current = (self.current + 1) % self.matches.len();
    }

    pub fn prev(&mut self) {
        if self.matches.is_empty() {
            return;
        }
        if self.current == 0 {
            self.current = self.matches.len() - 1;
        } else {
            self.current -= 1;
        }
    }
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>) -> Self {
        register_fonts(&cc.egui_ctx);
        // Load the brand icon into a GPU texture (used in the top bar).
        let icon_texture = load_icon_texture(&cc.egui_ctx);
        Self {
            buffer: Buffer::new(),
            scroll_state: ScrollState::default(),
            search: SearchState::default(),
            pending_path_slot: None,
            is_drag_hovered: false,
            error_banner: None,
            edit: EditState::default(),
            decode_scratch: String::with_capacity(512),
            icon_texture,
        }
    }

    /// Borrow the brand icon texture, if loaded.
    pub fn icon_texture(&self) -> Option<&egui::TextureHandle> {
        self.icon_texture.as_ref()
    }

    /// Open a path synchronously (drag-drop / CLI). Errors surface as a banner.
    pub fn open_path(&mut self, path: PathBuf) {
        match self.buffer.open(&path) {
            Ok(()) => {
                self.scroll_state = ScrollState::default();
                self.search.close();
                self.reset_edits();
            }
            Err(e) => {
                self.error_banner = Some(format!("{e}"));
                self.buffer.close();
                self.reset_edits();
            }
        }
    }

    /// Queue the native file-open dialog. The chosen path lands asynchronously.
    pub fn request_open_dialog(&mut self) {
        // Only one dialog at a time.
        if self.pending_path_slot.is_some() {
            return;
        }
        let slot: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
        self.pending_path_slot = Some(slot.clone());
        thread::spawn(move || {
            let picked = rfd::FileDialog::new()
                .add_filter(
                    "Text",
                    &["txt", "log", "md", "csv", "json", "xml", "sql", "ini", "cfg"],
                )
                .add_filter("All", &["*"])
                .pick_file();
            *slot.lock().unwrap() = picked;
        });
    }

    /// Close the current file and reset scroll/search.
    pub fn close_file(&mut self) {
        self.buffer.close();
        self.scroll_state = ScrollState::default();
        self.search.close();
        self.reset_edits();
    }

    /// Drop any pending edits / inline-editor state (keeps the mode flag).
    fn reset_edits(&mut self) {
        self.edit.edits.clear();
        self.edit.editing_line = None;
        self.edit.draft.clear();
        self.edit.modified = false;
        self.edit.focus_requested = false;
        self.edit.confirm_discard = false;
    }

    /// Total lines the renderer should show: the buffer's count plus the edit
    /// overlay's delta (identity when edit mode is off or nothing is edited).
    pub fn logical_total_lines(&self) -> usize {
        self.edit.edits.total_lines(self.buffer.total_lines())
    }

    /// Turn edit mode on/off (Ctrl+E or the toolbar toggle). Leaving with
    /// unsaved edits first asks for confirmation via `edit.confirm_discard`.
    pub fn toggle_edit_mode(&mut self) {
        if self.buffer.state() != BufferState::Ready {
            return;
        }
        if self.edit.enabled && self.edit.modified {
            self.edit.confirm_discard = true;
            return;
        }
        self.set_edit_enabled(!self.edit.enabled);
    }

    pub fn set_edit_enabled(&mut self, on: bool) {
        self.commit_draft();
        self.edit.enabled = on;
        self.edit.editing_line = None;
        self.edit.draft.clear();
        self.edit.focus_requested = false;
        if !on {
            self.edit.edits.clear();
            self.edit.modified = false;
            self.edit.confirm_discard = false;
        }
    }

    /// Commit the inline editor's draft into the overlay.
    fn commit_draft(&mut self) {
        let Some(line) = self.edit.editing_line else {
            return;
        };
        let text = std::mem::take(&mut self.edit.draft);
        self.edit.edits.set_line(self.buffer.total_lines(), line, text);
        self.edit.modified = true;
        self.edit.editing_line = None;
        self.edit.search_stale = true;
    }

    /// Start editing `line`: commit anything in flight, then load its content
    /// (edited or lossy-decoded original) into the draft.
    fn begin_editing(&mut self, line: usize) {
        self.commit_draft();
        let total = self.buffer.total_lines();
        self.edit.draft = match self.edit.edits.view(total, line) {
            LineView::Edited(t) => t.to_string(),
            LineView::Original(orig) => {
                let bytes = self.buffer.line(orig).unwrap_or_default();
                String::from_utf8_lossy(edit::trim_eol(bytes)).into_owned()
            }
        };
        self.edit.editing_line = Some(line);
        self.edit.focus_requested = true;
    }

    /// Save the edited content back to the open file (Ctrl+S).
    ///
    /// Streams the merged content to a temp file next to the original, then
    /// swaps it in (our mapping must be dropped first — Windows refuses to
    /// replace a mapped file) and reopens + reindexes, preserving the scroll
    /// position.
    pub fn save(&mut self) {
        if !self.edit.enabled || !self.edit.modified {
            return;
        }
        let (Some(path), Some(index), mmap) = (
            self.buffer.path().map(ToOwned::to_owned),
            self.buffer.index_ref().cloned(),
            self.buffer.mmap_arc().cloned(),
        ) else {
            return;
        };
        // An empty file has no mapping; its single line is represented by the
        // index alone, and the original byte slice is simply empty.
        let bytes: &[u8] = mmap.as_deref().map(|m| &m[..]).unwrap_or(&[]);

        let tmp = path.with_file_name(format!(
            "{}.inpriv-tmp",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
        match edit::write_file(&self.edit.edits, bytes, &index, &tmp) {
            Ok(_) => {
                // Drop our mapping before replacing the file.
                self.buffer.close();
                let swap = std::fs::rename(&tmp, &path)
                    .or_else(|_| {
                        std::fs::remove_file(&path)
                            .and_then(|()| std::fs::rename(&tmp, &path))
                    })
                    .or_else(|_| {
                        std::fs::copy(&tmp, &path)
                            .and_then(|_| std::fs::remove_file(&tmp))
                    });
                match swap {
                    Ok(()) => {
                        let top = self.scroll_state.top_line;
                        match self.buffer.open(&path) {
                            Ok(()) => {
                                self.reset_edits();
                                self.search.close();
                                // `open` reset the scroll; restore the view.
                                self.scroll_state.scroll_to_line = Some(top);
                            }
                            Err(e) => self.error_banner = Some(format!("{e}")),
                        }
                    }
                    Err(e) => {
                        self.error_banner = Some(format!(
                            "saved to {} but could not replace the original: {e}",
                            tmp.display()
                        ));
                    }
                }
            }
            Err(e) => {
                std::fs::remove_file(&tmp).ok();
                self.error_banner = Some(format!("failed to save: {e}"));
            }
        }
    }

    /// Take (consume) the deferred error banner, if any.
    pub fn take_error(&mut self) -> Option<String> {
        self.error_banner.take()
    }

    /// Decode a line's bytes for display. Reuses a scratch buffer to avoid
    /// per-frame heap churn on the common ASCII path.
    pub fn decode_line(&mut self, bytes: &[u8]) -> &str {
        self.decode_scratch.clear();
        if bytes.is_ascii() {
            // Safe: ASCII is always valid UTF-8.
            self.decode_scratch
                .push_str(std::str::from_utf8(bytes).unwrap_or(""));
        } else {
            let cow = std::string::String::from_utf8_lossy(bytes);
            self.decode_scratch.push_str(&cow);
        }
        self.decode_scratch.as_str()
    }

    fn handle_shortcuts(&mut self, ctx: &Context) {
        if ctx.input_mut(|i| i.consume_key(SHORTCUT_MOD, Key::O)) {
            self.request_open_dialog();
        }
        if ctx.input_mut(|i| i.consume_key(SHORTCUT_MOD, Key::F)) {
            self.search.toggle();
        }
        if self.search.open
            && ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape))
        {
            self.search.close();
        }
        if self.search.open && !self.search.matches.is_empty() {
            let shift = ctx.input(|i| i.modifiers.shift);
            if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter)) {
                if shift {
                    self.goto_prev_match();
                } else {
                    self.goto_next_match();
                }
            }
        }

        // Edit-mode keys. Handled here, before the UI renders the inline
        // editor, so the TextEdit never swallows them.
        if self.edit.enabled {
            if ctx.input_mut(|i| i.consume_key(SHORTCUT_MOD, Key::E)) {
                self.toggle_edit_mode();
            }
            if ctx.input_mut(|i| i.consume_key(SHORTCUT_MOD, Key::S)) {
                self.save();
            }
            let editing = self.edit.editing_line;
            if !self.search.open {
                if let Some(cur) = editing {
                    if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Enter)) {
                        self.commit_draft();
                        // Step to the next line, appending one at EOF.
                        if cur + 1 >= self.logical_total_lines() {
                            self.insert_line_after(cur);
                        }
                        self.begin_editing(cur + 1);
                        self.scroll_state.scroll_to_line = Some(cur + 1);
                    }
                    if ctx.input_mut(|i| i.consume_key(Modifiers::CTRL, Key::Enter)) {
                        self.commit_draft();
                        self.insert_line_after(cur);
                        self.begin_editing(cur + 1);
                        self.scroll_state.scroll_to_line = Some(cur + 1);
                    }
                    if ctx.input_mut(|i| i.consume_key(Modifiers::CTRL, Key::D)) {
                        self.edit
                            .edits
                            .delete_line(self.buffer.total_lines(), cur);
                        self.edit.modified = true;
                        self.edit.search_stale = true;
                        self.edit.editing_line = None;
                        self.edit.draft.clear();
                    }
                    if ctx.input_mut(|i| i.consume_key(Modifiers::NONE, Key::Escape)) {
                        self.commit_draft();
                    }
                }
            }
        }
    }

    /// Insert an empty line after logical line `cur` and mark the edit dirty.
    fn insert_line_after(&mut self, cur: usize) {
        self.edit
            .edits
            .insert_after(self.buffer.total_lines(), cur, String::new());
        self.edit.modified = true;
        self.edit.search_stale = true;
    }

    /// Advance to the next search match and scroll it into view.
    pub fn goto_next_match(&mut self) {
        self.search.next();
        self.scroll_to_current_match();
    }

    /// Step to the previous search match and scroll it into view.
    pub fn goto_prev_match(&mut self) {
        self.search.prev();
        self.scroll_to_current_match();
    }

    fn scroll_to_current_match(&mut self) {
        if let Some(&hit) = self.search.matches.get(self.search.current) {
            // Hits are recorded against original lines; translate through the
            // edit overlay (deleted lines simply don't scroll anywhere).
            let line = if self.edit.edits.is_empty() {
                Some(hit.line)
            } else {
                self.edit
                    .edits
                    .logical_of_original(self.buffer.total_lines(), hit.line)
            };
            if let Some(line) = line {
                // Drive the ScrollArea via the pending-scroll slot; writing
                // `top_line` directly has no effect (the renderer overwrites it).
                self.scroll_state.scroll_to_line = Some(line);
            }
        }
    }

    /// Pump the search pipeline: kick off a scan when the query changes, and
    /// collect results when they land.
    fn pump_search(&mut self) {
        // An edit changed line numbering (or content) — rescan the file bytes.
        if self.edit.search_stale {
            self.edit.search_stale = false;
            self.search.dirty = true;
        }
        if !self.search.open {
            return;
        }
        if self.search.query != self.search.last_query {
            self.search.dirty = true;
            self.search.last_query = self.search.query.clone();
        }
        if self.search.query.is_empty() {
            self.search.matches.clear();
            self.search.current = 0;
            self.search.dirty = false;
            return;
        }
        if self.search.dirty && self.buffer.state() == BufferState::Ready {
            self.search.dirty = false;
            self.start_search();
        }
        // Take the result out of the mutex into a local so the guard drops
        // before we borrow `self` mutably below.
        let new_hits = self.search.search_result.lock().unwrap().take();
        if let Some(hits) = new_hits {
            self.search.matches = hits;
            self.search.current = 0;
            // Jump to the first match so the user sees a result, not just a count.
            self.scroll_to_current_match();
        }
    }

    /// Launch a background thread to find all occurrences of the current query.
    /// Safe: passes owned `Arc<Mmap>` + `Arc<LineIndex>` clones across the
    /// thread boundary; no raw pointers, no lifetime gymnastics.
    fn start_search(&mut self) {
        self.search.search_cancel.store(true, Ordering::Relaxed);
        self.search.search_cancel = Arc::new(AtomicBool::new(false));
        *self.search.search_result.lock().unwrap() = None;

        let Some(mmap) = self.buffer.mmap_arc().cloned() else {
            return;
        };
        let Some(index) = self.buffer.index_ref().cloned() else {
            return;
        };
        let query = self.search.query.clone();
        let cancel = self.search.search_cancel.clone();
        let sink = self.search.search_result.clone();

        thread::spawn(move || {
            let hits = scan_matches(&mmap, &index, query.as_bytes(), &cancel);
            *sink.lock().unwrap() = Some(hits);
        });
    }
}

/// Brute-force substring scan over every line. Uses `memchr` to locate the
/// query's first byte, then verifies. O(file size) — adequate for a first cut;
/// can be upgraded to Aho-Corasick for many-result queries.
fn scan_matches(
    mmap: &Mmap,
    index: &LineIndex,
    query: &[u8],
    cancel: &AtomicBool,
) -> Vec<SearchHit> {
    if query.is_empty() {
        return Vec::new();
    }
    let bytes: &[u8] = &mmap[..];
    let total = index.line_count();
    let mut hits = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(4);

    for i in 0..total {
        // Coarse cancellation: check every 4096 lines / at the deadline.
        if (i & 0xFFF == 0 && cancel.load(Ordering::Relaxed)) || Instant::now() > deadline {
            return Vec::new();
        }
        let (s, e) = match index.span(i, bytes.len()) {
            Some(x) => x,
            None => continue,
        };
        let line = &bytes[s..e];
        let mut from = 0;
        while from < line.len() {
            // `memchr` returns `Option<usize>` (a single match), not an iterator.
            let Some(rel) = memchr::memchr(query[0], &line[from..]) else {
                break;
            };
            let abs = from + rel;
            if abs + query.len() <= line.len() && &line[abs..abs + query.len()] == query {
                hits.push(SearchHit { line: i, byte: abs });
            }
            from = abs + 1;
        }
    }
    hits
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // 1. Drain the background file-dialog result, if it's done.
        if let Some(slot) = self.pending_path_slot.take() {
            let mut guard = slot.lock().unwrap();
            if guard.is_some() {
                if let Some(path) = guard.take() {
                    drop(guard);
                    self.open_path(path);
                }
            } else {
                // Not ready yet; put the slot back for next frame.
                drop(guard);
                self.pending_path_slot = Some(slot);
                ctx.request_repaint_after(Duration::from_millis(40));
            }
        }

        // 2. Poll the buffer's background indexer.
        self.buffer.poll_indexing();

        // 3. Keyboard shortcuts.
        self.handle_shortcuts(ctx);

        // 4. Search pipeline.
        self.pump_search();

        // 5. Drag-and-drop hover + dropped-file handling.
        self.is_drag_hovered = !ctx.input(|i| i.raw.hovered_files.is_empty());
        if let Some(file) =
            ctx.input(|i| i.raw.dropped_files.iter().find_map(|f| f.path.clone()))
        {
            self.open_path(file);
        }

        // 6. Keep repainting while indexing / searching / waiting on a dialog
        //    so progress and results stream in.
        if matches!(self.buffer.state(), BufferState::Indexing(_)) {
            ctx.request_repaint();
        }

        // 7. Render.
        ui::root(ctx, self);
    }
}

/// Font + base style registration. No custom font file is bundled (keeps the
/// binary small); egui's built-in monospace is used for all code/text content.
fn register_fonts(ctx: &Context) {
    let mut style = (*ctx.style()).clone();
    style.text_styles.entry(egui::TextStyle::Body).or_default().size = 13.0;
    ctx.set_style(style);
    // Ensure the default font set (Monospace family) is initialized.
    ctx.set_fonts(FontDefinitions::default());
    let _ = FontFamily::Monospace;
}

/// A pre-downscaled 96px variant of the brand icon for crisp in-UI rendering.
/// Displaying a 2048px texture at 22px with bilinear filtering looks
/// "compressed"; sampling a near-native-resolution texture (with mipmaps) is
/// sharp. The full-res `icon.png` is embedded separately in `main.rs` for the
/// OS window icon.
const ICON_SMALL_PNG: &[u8] = include_bytes!("../assets/icon_small.png");

/// Decode the small icon variant and upload it as a GPU texture with mipmaps
/// enabled, so it stays crisp at the ~22px display size. Returns `None` on any
/// decode failure — callers fall back to a vector mark.
fn load_icon_texture(ctx: &Context) -> Option<egui::TextureHandle> {
    let img = image::load_from_memory(ICON_SMALL_PNG).ok()?.into_rgba8();
    let size = [img.width() as usize, img.height() as usize];
    let image = egui::ColorImage::from_rgba_unmultiplied(size, img.as_raw());
    // Mipmaps: the glow backend auto-generates them when mipmap_mode is set,
    // keeping the icon crisp when minified to small display sizes.
    let options = egui::TextureOptions {
        magnification: egui::TextureFilter::Linear,
        minification: egui::TextureFilter::Linear,
        wrap_mode: egui::TextureWrapMode::ClampToEdge,
        mipmap_mode: Some(egui::TextureFilter::Linear),
    };
    Some(ctx.load_texture("brand-icon", image, options))
}
