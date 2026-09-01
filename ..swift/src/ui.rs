//! UI: virtual-scrolled text view, dark theme, and status bar for [`App`](crate::app::App).
//!
//! Strict virtual scrolling — only the ~30–60 lines in the viewport are walked
//! per frame, drawn straight from the memory-mapped `&[u8]` via
//! [`Buffer::line`](crate::buffer::Buffer::line). No line content is ever
//! heap-allocated, so scroll FPS is independent of file size.

use egui::{
    Align2, Color32, FontId, Pos2, Rect, Response, Rounding, ScrollArea, Sense, Stroke, Vec2,
};
use egui::{Context, Ui};

use crate::app::App;
use crate::buffer::BufferState;
use crate::edit::{trim_eol, EditState, LineView};
use crate::indexer::LineIndex;

/// Lightweight row-tint descriptor: a search hit's line + whether it's current.
struct SearchHitRef {
    line: usize,
    is_current: bool,
}

/// Decode `bytes` into `scratch` and return the result as `&str`. Reuses the
/// buffer across calls to avoid per-line allocation on the ASCII fast path.
fn decode_into<'a>(scratch: &'a mut String, bytes: &[u8]) -> &'a str {
    scratch.clear();
    if bytes.is_ascii() {
        // ASCII is always valid UTF-8.
        scratch.push_str(std::str::from_utf8(bytes).unwrap_or(""));
    } else {
        // Lossy: handles Latin-1 / invalid bytes without panicking.
        scratch.push_str(&std::string::String::from_utf8_lossy(bytes));
    }
    scratch.as_str()
}

/// Background tint for a row carrying a search hit (current match brighter).
fn paint_row_tint(painter: &egui::Painter, hits: &[SearchHitRef], line: usize, text_x: f32, y: f32) {
    // Current match takes precedence (brighter tint).
    if hits.iter().any(|h| h.is_current && h.line == line) {
        painter.rect_filled(
            Rect::from_min_size(
                Pos2::new(text_x - 4.0, y + 1.0),
                Vec2::new(1e6, LINE_H - 2.0),
            ),
            Rounding::same(3.0),
            MATCH_CURRENT,
        );
        return;
    }
    if hits.iter().any(|h| h.line == line) {
        painter.rect_filled(
            Rect::from_min_size(
                Pos2::new(text_x - 4.0, y + 1.0),
                Vec2::new(1e6, LINE_H - 2.0),
            ),
            Rounding::same(3.0),
            MATCH,
        );
    }
}

// --- Theme: Inpriv Labs M3 "Earthy Forest" (dark). See inpriv-labs.md. ---
// Surface scale — near-black with a warm undertone.
pub const BG: Color32 = Color32::from_rgb(0x13, 0x14, 0x0e); // M3 Surface
pub const BG_DEEP: Color32 = Color32::from_rgb(0x0d, 0x0f, 0x09); // Surface Container Lowest
pub const BG_ELEV: Color32 = Color32::from_rgb(0x1a, 0x1c, 0x17); // Surface Container Low (panels)
pub const BG_GLASS: Color32 = Color32::from_rgb(0x1f, 0x21, 0x1b); // Surface Container (glass base)
pub const BG_HIGH: Color32 = Color32::from_rgb(0x29, 0x2b, 0x25); // Surface Container High (hover)
// Accents — lime-green primary + soft coral tertiary.
pub const ACCENT: Color32 = Color32::from_rgb(0xab, 0xd3, 0x7a); // M3 Primary (lime)
pub const ACCENT_DIM: Color32 = Color32::from_rgb(0x2e, 0x4f, 0x2f); // Primary Container (dark green)
pub const ACCENT_TERT: Color32 = Color32::from_rgb(0xff, 0xb4, 0xa5); // Tertiary (soft coral)
// Text — warm off-whites.
pub const TEXT: Color32 = Color32::from_rgb(0xe3, 0xe2, 0xd3); // On Surface
pub const TEXT_DIM: Color32 = Color32::from_rgb(0xc3, 0xc8, 0xb6); // On Surface Variant (sage)
pub const LINE_NUM: Color32 = Color32::from_rgb(0x8d, 0x92, 0x83); // Outline (gutter digits)
// Separators.
pub const BORDER: Color32 = Color32::from_rgb(0x43, 0x48, 0x3d); // Outline Variant
pub const BORDER_STRONG: Color32 = Color32::from_rgb(0x8d, 0x92, 0x83); // Outline
// Search-match tints (primary + tertiary, low alpha).
pub const MATCH: Color32 = Color32::from_rgba_premultiplied(0xab, 0xd3, 0x7a, 0x44);
pub const MATCH_CURRENT: Color32 = Color32::from_rgba_premultiplied(0xff, 0xb4, 0xa5, 0x77);
// Error.
pub const ERROR: Color32 = Color32::from_rgb(0xff, 0xb4, 0xab); // M3 Error (dark)

/// Text font identifier (see [`App::register_fonts`]).
pub const MONO_FAMILY: egui::FontFamily = egui::FontFamily::Monospace;

const LINE_H: f32 = 18.0; // row height in px (kept stable for offset math)
const GUTTER_PAD_RIGHT: f32 = 16.0; // gap between gutter digits and text
const TOP_BAR_H: f32 = 44.0; // header bar height
const STATUS_BAR_H: f32 = 28.0; // bottom status bar height
const SEARCH_BAR_H: f32 = 40.0; // search strip height (when visible)

/// Linearly interpolate two colors by `t` in 0..=1 (clamped).
fn lerp_color(a: Color32, b: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    Color32::from_rgba_premultiplied(
        (a.r() as f32 + (b.r() as f32 - a.r() as f32) * t) as u8,
        (a.g() as f32 + (b.g() as f32 - a.g() as f32) * t) as u8,
        (a.b() as f32 + (b.b() as f32 - a.b() as f32) * t) as u8,
        (a.a() as f32 + (b.a() as f32 - a.a() as f32) * t) as u8,
    )
}

/// Top-level entry: lays out the whole window (top bar → content → status bar).
pub fn root(ctx: &Context, app: &mut App) {
    apply_theme(ctx);
    let screen = ctx.screen_rect();

    // One-shot entrance animation 0→1 on launch (spring curve, ~0.7s).
    let entrance = ctx.animate_value_with_time(egui::Id::new("global_entrance"), 1.0, 0.7);
    let entrance = crate::anim::spring_progress(entrance);

    egui::TopBottomPanel::top("top_bar")
        .exact_height(TOP_BAR_H)
        .frame(panel_frame())
        .show(ctx, |ui| {
            top_bar(ui, app, entrance);
        });

    egui::TopBottomPanel::bottom("status_bar")
        .exact_height(STATUS_BAR_H)
        .frame(panel_frame())
        .show(ctx, |ui| {
            status_bar(ui, app);
        });

    let search_open = app.search.open;
    egui::TopBottomPanel::bottom("search_bar")
        .exact_height(if search_open { SEARCH_BAR_H } else { 0.0 })
        .frame(egui::Frame::none())
        .show_animated(ctx, search_open, |ui| {
            search_bar(ui, app);
        });

    egui::CentralPanel::default()
        .frame(egui::Frame::none().fill(BG))
        .show(ctx, |ui| {
            let _ = screen;
            workspace(ui, app, entrance);
        });

    // Confirm-before-discarding unsaved edits when leaving edit mode.
    if app.edit.confirm_discard {
        egui::Window::new("Discard edits?")
            .collapsible(false)
            .resizable(false)
            .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
            .show(ctx, |ui| {
                ui.label("There are unsaved edits. Leaving edit mode discards them.");
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    if ui.button("Discard and leave").clicked() {
                        app.set_edit_enabled(false);
                    }
                    if ui.button("Keep editing").clicked() {
                        app.edit.confirm_discard = false;
                    }
                });
            });
    }
}

/// Apply the M3 "Earthy Forest" dark theme to the egui style.
fn apply_theme(ctx: &Context) {
    let mut style = (*ctx.style()).clone();
    style.visuals = egui::Visuals::dark();
    // M3 surface scale.
    style.visuals.panel_fill = BG;
    style.visuals.extreme_bg_color = BG_DEEP;
    style.visuals.faint_bg_color = BG_ELEV;
    style.visuals.widgets.noninteractive.bg_fill = BG;
    style.visuals.widgets.noninteractive.fg_stroke = egui::Stroke::new(1.0, TEXT);
    // Hover uses Surface Container High; active pops to Primary.
    style.visuals.widgets.hovered.bg_fill = BG_HIGH;
    style.visuals.widgets.hovered.fg_stroke = egui::Stroke::new(1.0, TEXT);
    style.visuals.widgets.active.bg_fill = ACCENT_DIM;
    style.visuals.widgets.active.fg_stroke = egui::Stroke::new(1.0, ACCENT);
    style.visuals.widgets.inactive.bg_fill = BG_ELEV;
    style.visuals.widgets.inactive.fg_stroke = egui::Stroke::new(1.0, TEXT_DIM);
    // Selection = Primary (lime) fill + Tertiary (coral) stroke for contrast.
    style.visuals.selection.bg_fill = ACCENT;
    style.visuals.selection.stroke = egui::Stroke::new(1.0, ACCENT_TERT);
    style.visuals.window_fill = BG_ELEV;
    style.visuals.window_stroke = egui::Stroke::new(1.0, BORDER);
    style.visuals.widgets.noninteractive.bg_stroke = egui::Stroke::new(1.0, BORDER);
    // Slightly snappier animation feel (M3 motion is springy).
    style.animation_time = 0.18;
    // Larger, softer rounding per M3 spec.
    style.visuals.window_rounding = egui::Rounding::same(14.0);
    style.visuals.menu_rounding = egui::Rounding::same(10.0);
    ctx.set_style(style);
}

fn panel_frame() -> egui::Frame {
    egui::Frame::none()
        .fill(BG_ELEV)
        .stroke(egui::Stroke::new(1.0, BORDER))
        .inner_margin(egui::Margin {
            left: 14.0,
            right: 14.0,
            top: 6.0,
            bottom: 6.0,
        })
}

/// An icon-only button of the given square `size`. Paints an animated hover/active
/// background (spring-soft easing per the M3 spec) and draws `icon_fn` centered,
/// tinted by an interpolated interaction color.
fn icon_button_sized(
    ui: &mut Ui,
    size: f32,
    tooltip: &str,
    icon_fn: impl FnOnce(&egui::Painter, Pos2, f32, Color32),
) -> Response {
    let (rect, response) = ui.allocate_exact_size(Vec2::splat(size), Sense::click());
    let response = response.on_hover_text(tooltip);
    let id = response.id;

    // Animated hover/press intensity in 0..=1 (spring-soft curve).
    let target = if response.is_pointer_button_down_on() {
        1.0
    } else if response.hovered() {
        0.6
    } else {
        0.0
    };
    let t = ui.ctx().animate_value_with_time(id.with("hover"), target, 0.18);

    // Background fades in as the hover intensity rises.
    if t > 0.001 {
        let bg_alpha = (t * 180.0) as u8;
        let bg = if response.is_pointer_button_down_on() {
            Color32::from_rgba_premultiplied(0xab, 0xd3, 0x7a, bg_alpha.min(90))
        } else {
            Color32::from_rgba_premultiplied(0xe3, 0xe2, 0xd3, bg_alpha.min(40))
        };
        ui.painter().rect_filled(rect, Rounding::same(8.0), bg);
    }

    // Interpolate icon color: TEXT_DIM → TEXT → ACCENT across the intensity.
    let color = if response.is_pointer_button_down_on() {
        // On press, blend from TEXT toward ACCENT.
        lerp_color(TEXT, ACCENT, t)
    } else {
        lerp_color(TEXT_DIM, TEXT, t / 0.6)
    };
    let icon_size = rect.width().min(rect.height()) * 0.78;
    icon_fn(ui.painter(), rect.center(), icon_size, color);
    response
}

/// Default-size (26px) icon button — for the top bar where height is generous.
fn icon_button(
    ui: &mut Ui,
    tooltip: &str,
    icon_fn: impl FnOnce(&egui::Painter, Pos2, f32, Color32),
) -> Response {
    icon_button_sized(ui, 26.0, tooltip, icon_fn)
}

// ============================ Top bar ============================

fn top_bar(ui: &mut Ui, app: &mut App, entrance: f32) {
    // Fade the bar contents in on launch (M3 barIn).
    let alpha = entrance.clamp(0.0, 1.0);
    ui.horizontal_centered(|ui| {
        // Brand mark: the actual icon.png as a raster image, falling back to a
        // vector diamond if the texture failed to load. The icon already has its
        // own colors (warm off-white diamond), so we render it unmodified —
        // tinting a white icon dark-then-bright during the entrance animation is
        // what made it look "broken".
        let mark_size = Vec2::splat(22.0);
        if let Some(tex) = app.icon_texture() {
            ui.add(egui::Image::from_texture(tex).fit_to_exact_size(mark_size));
        } else {
            let (mark_rect, _) = ui.allocate_exact_size(mark_size, Sense::hover());
            crate::icons::diamond(ui.painter(), mark_rect.center(), 18.0, ACCENT);
        }
        ui.label(
            egui::RichText::new("Inpriv Swift")
                .font(FontId::proportional(14.0))
                .color(lerp_color(BG_ELEV, TEXT, alpha))
                .strong(),
        );

        ui.add_space(16.0);
        ui.separator();
        ui.add_space(8.0);

        if ui.button("Open…").clicked() {
            app.request_open_dialog();
        }
        if app.buffer.state() != BufferState::Empty {
            if ui.button("Close").clicked() {
                app.close_file();
            }
        }

        ui.add_space(12.0);
        if let Some(p) = app.buffer.path() {
            ui.label(
                egui::RichText::new(p.display().to_string())
                    .color(TEXT_DIM)
                    .family(MONO_FAMILY),
            );
        }

        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let tooltip = if app.search.open { "Hide search (Esc)" } else { "Search (Ctrl+F)" };
            if icon_button(ui, tooltip, |p, c, s, col| crate::icons::search(p, c, s, col)).clicked() {
                app.search.toggle();
            }
            if app.buffer.state() == BufferState::Ready {
                // Edit-mode toggle (optional; off by default).
                let et = if app.edit.enabled {
                    "Leave edit mode (Ctrl+E)"
                } else {
                    "Edit mode (Ctrl+E) — click a line to edit; Enter=next, Ctrl+Enter=new line, Ctrl+D=delete, Esc=done, Ctrl+S=save"
                };
                if icon_button(ui, et, crate::icons::pencil).clicked() {
                    app.toggle_edit_mode();
                }
                if app.edit.enabled {
                    let can_save = app.edit.modified;
                    let st = if can_save { "Save (Ctrl+S)" } else { "Save (Ctrl+S) — no changes yet" };
                    if icon_button(ui, st, crate::icons::save).clicked() {
                        app.save();
                    }
                }
            }
        });
    });
}

// ============================ Status bar ============================

fn status_bar(ui: &mut Ui, app: &mut App) {
    ui.horizontal_centered(|ui| {
        let state = app.buffer.state();
        // State pill.
        let (dot, label) = match state {
            BufferState::Empty => (TEXT_DIM, "empty"),
            BufferState::Indexing(f) => {
                ui.add(egui::Spinner::new().size(12.0).color(ACCENT));
                ui.label(
                    egui::RichText::new(format!("indexing {:.0}%", f * 100.0)).color(ACCENT),
                );
                (ACCENT, "")
            }
            BufferState::Ready => (ACCENT, "ready"),
            BufferState::Failed => (ERROR, "failed"),
        };
        if !matches!(state, BufferState::Indexing(_)) {
            status_dot(ui, dot);
            ui.label(egui::RichText::new(label).color(TEXT_DIM));
        }

        // Edit-mode indicator: coral when there are unsaved edits.
        if app.edit.enabled {
            ui.add_space(8.0);
            if app.edit.modified {
                status_dot(ui, ACCENT_TERT);
                ui.label(egui::RichText::new("unsaved edits").color(ACCENT_TERT).small());
            } else {
                status_kv(ui, "Edit", "on".to_string());
            }
        }

        ui.add_space(12.0);
        ui.separator();
        ui.add_space(8.0);

        if state == BufferState::Empty {
            ui.label(
                egui::RichText::new("No file loaded — drop a file or click Open.")
                    .color(TEXT_DIM),
            );
            return;
        }

        status_kv(ui, "Size", format_bytes(app.buffer.size_bytes()));
        sep(ui);
        status_kv(ui, "Lines", fmt_thousands(app.logical_total_lines() as u64));
        if let Some(ms) = app.buffer.index_time_ms() {
            sep(ui);
            status_kv(ui, "Indexed", format!("{} ms", ms));
        }

        // Right-aligned: viewport position.
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let total = app.logical_total_lines();
            if state == BufferState::Ready && total > 0 {
                let pct = ((app.scroll_state.top_line as f64 / total as f64) * 100.0) as u32;
                status_kv(
                    ui,
                    "View",
                    format!(
                        "line {} / {} ({}%)",
                        fmt_thousands(app.scroll_state.top_line as u64 + 1),
                        fmt_thousands(total as u64),
                        pct
                    ),
                );
            }
        });
    });
}

fn status_kv(ui: &mut Ui, key: &str, value: String) {
    ui.label(egui::RichText::new(key).color(TEXT_DIM).small());
    ui.label(egui::RichText::new(value).color(TEXT).small().family(MONO_FAMILY));
}

fn status_dot(ui: &mut Ui, color: Color32) {
    let (rect, _) =
        ui.allocate_exact_size(Vec2::splat(8.0), Sense::hover());
    ui.painter()
        .circle_filled(rect.center(), 3.5, color);
}

fn sep(ui: &mut Ui) {
    ui.separator();
}

// ============================ Search bar ============================

fn search_bar(ui: &mut Ui, app: &mut App) {
    // `horizontal_centered` vertically centers every widget in the row. The
    // icon buttons use the same target height as the text field so their
    // visual centers line up.
    ui.horizontal_centered(|ui| {
        ui.add_space(8.0);
        let resp = ui.add(
            egui::TextEdit::singleline(&mut app.search.query)
                .hint_text("Find…")
                .desired_width(360.0)
                .font(FontId::monospace(13.0)),
        );
        if app.search.focus_requested {
            resp.request_focus();
            app.search.focus_requested = false;
        }

        let count = app.search.matches.len();
        let cur = app.search.current;
        ui.label(
            egui::RichText::new(if count == 0 {
                "0 / 0".to_string()
            } else {
                format!("{} / {}", cur + 1, count)
            })
            .color(TEXT_DIM)
            .family(MONO_FAMILY),
        );

        ui.add_space(8.0);
        // 22px buttons match the text field's visual height so the row stays
        // on a single centered baseline.
        if icon_button_sized(ui, 22.0, "Previous (Shift+Enter)", |p, c, s, col| {
            crate::icons::chevron_up(p, c, s, col)
        })
        .clicked()
        {
            app.goto_prev_match();
        }
        if icon_button_sized(ui, 22.0, "Next (Enter)", |p, c, s, col| {
            crate::icons::chevron_down(p, c, s, col)
        })
        .clicked()
        {
            app.goto_next_match();
        }
        if icon_button_sized(ui, 22.0, "Close (Esc)", |p, c, s, col| {
            crate::icons::close(p, c, s, col)
        })
        .clicked()
        {
            app.search.close();
        }
    });
}

// ============================ Workspace (virtual scroll) ============================

fn workspace(ui: &mut Ui, app: &mut App, entrance: f32) {
    // Handle deferred errors from a background open attempt.
    if let Some(msg) = app.take_error() {
        show_error_banner(ui, &msg);
        return;
    }

    let state = app.buffer.state();
    match state {
        BufferState::Empty => empty_state(ui, entrance),
        BufferState::Indexing(frac) => indexing_state(ui, frac),
        BufferState::Failed => failed_state(ui),
        BufferState::Ready => render_text(ui, app),
    }
}

fn empty_state(ui: &mut Ui, entrance: f32) {
    // Fade the empty state up after the bar settles (M3 fadeUp, delayed).
    let alpha = crate::anim::spring_progress((entrance - 0.2).max(0.0) / 0.8);
    let avail = ui.available_size();
    let (rect, _) = ui.allocate_exact_size(avail, Sense::hover());
    let painter = ui.painter_at(rect);
    let center = rect.center();
    painter.text(
        center,
        Align2::CENTER_CENTER,
        "Drop a file here, or click Open…",
        FontId::proportional(16.0),
        lerp_color(BG, TEXT_DIM, alpha),
    );
    painter.text(
        center + Vec2::Y * 28.0,
        Align2::CENTER_CENTER,
        "Supports massive files (multi-GB). Zero-copy memory mapping.",
        FontId::proportional(12.0),
        lerp_color(BG, LINE_NUM, alpha),
    );
}

fn indexing_state(ui: &mut Ui, frac: f32) {
    let avail = ui.available_size();
    let (rect, _) = ui.allocate_exact_size(avail, Sense::hover());
    let painter = ui.painter_at(rect);
    let center = rect.center();

    painter.text(
        center - Vec2::Y * 22.0,
        Align2::CENTER_CENTER,
        "Indexing…",
        FontId::proportional(16.0),
        TEXT,
    );

    // Progress bar.
    let bar_w = 260.0_f32.min(rect.width() * 0.6);
    let bar = Rect::from_center_size(center, Vec2::new(bar_w, 6.0));
    painter.rect_filled(bar, Rounding::same(3.0), BG_ELEV);
    let fill = Rect::from_min_size(
        bar.min,
        Vec2::new(bar.width() * frac.clamp(0.0, 1.0), bar.height()),
    );
    painter.rect_filled(fill, Rounding::same(3.0), ACCENT);

    painter.text(
        center + Vec2::Y * 22.0,
        Align2::CENTER_CENTER,
        format!("{:.1}%", frac * 100.0),
        FontId::monospace(12.0),
        TEXT_DIM,
    );
}

fn failed_state(ui: &mut Ui) {
    let avail = ui.available_size();
    let (rect, _) = ui.allocate_exact_size(avail, Sense::hover());
    let painter = ui.painter_at(rect);
    painter.text(
        rect.center(),
        Align2::CENTER_CENTER,
        "Failed to open file. Try another.",
        FontId::proportional(15.0),
        ERROR,
    );
}

fn show_error_banner(ui: &mut Ui, msg: &str) {
    let avail = ui.available_size();
    let (rect, _) = ui.allocate_exact_size(avail, Sense::hover());
    let painter = ui.painter_at(rect);
    let center = rect.center();
    painter.text(
        center - Vec2::Y * 12.0,
        Align2::CENTER_CENTER,
        "Could not open file",
        FontId::proportional(15.0),
        ERROR,
    );
    painter.text(
        center + Vec2::Y * 14.0,
        Align2::CENTER_CENTER,
        msg,
        FontId::proportional(12.0),
        TEXT_DIM,
    );
}

/// The hot path: render only the visible lines, zero-copy from the mmap.
///
/// With edit mode on, lines resolve through the edit overlay (`O(edits)` per
/// visible line — independent of file size) and one row hosts the inline
/// `TextEdit`. With edit mode off, or with no edits, this is the exact
/// original zero-copy path.
fn render_text(ui: &mut Ui, app: &mut App) {
    let total_original = app.buffer.total_lines();
    let edit_on = app.edit.enabled;
    let total_lines = if edit_on {
        app.edit.edits.total_lines(total_original)
    } else {
        total_original
    };
    if total_lines == 0 {
        return;
    }
    let index = app
        .buffer
        .index_ref()
        .expect("Ready state implies index present")
        .clone();
    let bytes = app
        .buffer
        .bytes()
        .expect("Ready state implies bytes present");

    // Clamp the remembered top line against the (possibly new) total.
    if app.scroll_state.top_line >= total_lines {
        app.scroll_state.top_line = total_lines.saturating_sub(1);
    }

    let gutter_w = gutter_width(total_lines);

    // Virtual content height. `total_lines * LINE_H` can exceed f32's integer
    // precision for very large files, but egui's scroll state handles the
    // sub-pixel fractional offset; we cap at a sane upper bound to avoid INF.
    let content_h = (total_lines as f64 * LINE_H as f64).min(f32::MAX as f64) as f32;

    // Snapshot the search matches so the paint closure borrows only this Vec,
    // not all of `app`. Hits are recorded against original lines; translate
    // them to logical lines through the overlay (deleted hits drop out).
    let search_matches: Vec<SearchHitRef> = {
        let edits = &app.edit.edits;
        let cur_line = app.search.matches.get(app.search.current).map(|h| h.line);
        app.search
            .matches
            .iter()
            .filter_map(|m| {
                let lg = if edits.is_empty() {
                    m.line
                } else {
                    edits.logical_of_original(total_original, m.line)?
                };
                Some(SearchHitRef {
                    line: lg,
                    is_current: cur_line == Some(m.line),
                })
            })
            .collect()
    };

    // We need `&mut` access to decode scratch inside the paint closure, and
    // to write back `top_line`. Split `app` into disjoint field borrows so the
    // closure captures only those, leaving the rest of `app` free afterward.
    let scratch = &mut app.decode_scratch;
    let top_line_out = &mut app.scroll_state.top_line;
    // Take the pending scroll target (set by search next/prev) so the closure
    // can act on it. This is the *only* way to drive the ScrollArea — writing
    // `top_line` directly is ignored because the renderer overwrites it.
    let pending_scroll = app.scroll_state.scroll_to_line.take();
    // Disjoint field borrows of the edit state for the inline editor.
    let EditState {
        edits,
        editing_line,
        draft,
        focus_requested,
        modified,
        search_stale,
        ..
    } = &mut app.edit;
    let editing_now = *editing_line;

    ScrollArea::vertical()
        .auto_shrink([false, false])
        .show_viewport(ui, |ui, viewport| {
            // Declare the full virtual height so the scrollbar reflects the
            // whole file. egui allocates exactly this much content.
            ui.set_height(content_h);

            // Row i paints at content_top + i * LINE_H (egui's show_rows model).
            let content_top = ui.max_rect().top();
            let content_left = ui.max_rect().left();

            // If search requested a scroll-to-line, compute that row's rect and
            // ask egui to center it in the viewport. egui animates the scroll.
            if let Some(line) = pending_scroll {
                let y = content_top + line as f32 * LINE_H;
                let target = Rect::from_min_size(
                    Pos2::new(content_left, y),
                    Vec2::new(ui.max_rect().width(), LINE_H),
                );
                ui.scroll_to_rect(target, Some(egui::Align::Center));
            }

            // Visible line range from the viewport (content coords, min=0 top).
            // f64 math so 14M-line files don't lose precision. The top may cut
            // a row mid-line (the usual smooth-scroll look), but the bottom is
            // floored: a row is only drawn when it fits fully above the status
            // bar, so the footer never swallows half of the last line.
            let top = ((viewport.min.y as f64) / LINE_H as f64)
                .floor()
                .max(0.0) as usize;
            let bottom = {
                let raw = ((viewport.max.y as f64) / LINE_H as f64).floor() as usize;
                raw.min(total_lines).max(top)
            };

            // Gutter band + separator, drawn behind the text.
            let gutter_rect = Rect::from_min_size(
                Pos2::new(content_left, content_top),
                Vec2::new(gutter_w, ui.max_rect().height()),
            );
            ui.painter().rect_filled(gutter_rect, Rounding::ZERO, BG);
            ui.painter().line_segment(
                [
                    Pos2::new(gutter_rect.max.x, ui.max_rect().top()),
                    Pos2::new(gutter_rect.max.x, ui.max_rect().bottom()),
                ],
                Stroke::new(1.0, BORDER),
            );

            let text_x = content_left + gutter_w + 4.0;
            let font = FontId::monospace(13.0);

            for i in top..bottom {
                let y = content_top + i as f32 * LINE_H;
                let cy = y + LINE_H * 0.5;

                // Search-match row tint (behind text).
                paint_row_tint(ui.painter(), &search_matches, i, text_x, y);

                // Gutter digit (1-indexed).
                ui.painter().text(
                    Pos2::new(gutter_rect.max.x - GUTTER_PAD_RIGHT, cy),
                    Align2::RIGHT_CENTER,
                    format!("{}", i + 1),
                    font.clone(),
                    LINE_NUM,
                );

                if edit_on && editing_now == Some(i) {
                    // The row under the inline editor: our own backdrop keeps
                    // it on-theme, the frameless TextEdit keeps it 18px tall.
                    let rect = Rect::from_min_size(
                        Pos2::new(text_x - 6.0, y + 1.0),
                        Vec2::new(
                            (ui.max_rect().width() - gutter_w - 14.0).max(80.0),
                            LINE_H - 2.0,
                        ),
                    );
                    ui.painter()
                        .rect_filled(rect.expand(2.0), Rounding::same(3.0), BG_GLASS);
                    ui.painter().rect_stroke(
                        rect.expand(2.0),
                        Rounding::same(3.0),
                        Stroke::new(1.0, ACCENT_DIM),
                    );
                    let resp = ui.put(
                        rect,
                        egui::TextEdit::singleline(&mut *draft)
                            .id(egui::Id::new("inline-line-editor"))
                            .desired_width(f32::INFINITY)
                            .font(FontId::monospace(13.0))
                            .frame(false),
                    );
                    if *focus_requested {
                        resp.request_focus();
                        *focus_requested = false;
                    }
                    continue;
                }

                if edit_on {
                    // Click-to-edit hit target (skipped for the editor row, so
                    // the TextEdit on top receives those clicks). Handled
                    // before the content resolve below, which borrows `edits`.
                    let row_rect = Rect::from_min_size(
                        Pos2::new(content_left, y),
                        Vec2::new(ui.max_rect().width(), LINE_H),
                    );
                    let resp = ui
                        .interact(row_rect, ui.id().with(("edit-row", i)), Sense::click())
                        .on_hover_cursor(egui::CursorIcon::Text);
                    if resp.clicked() {
                        // Commit any in-flight draft, then retarget the editor.
                        if let Some(prev) = editing_now {
                            let text = std::mem::take(&mut *draft);
                            edits.set_line(total_original, prev, text);
                            *modified = true;
                            *search_stale = true;
                        }
                        *editing_line = Some(i);
                        *draft = match edits.view(total_original, i) {
                            LineView::Edited(t) => t.to_string(),
                            LineView::Original(orig) => String::from_utf8_lossy(trim_eol(
                                line_slice(bytes, &index, orig),
                            ))
                            .into_owned(),
                        };
                        *focus_requested = true;
                    }
                }

                // Line content: through the overlay when editing, straight
                // from the mmap otherwise.
                let text: &str = if edit_on {
                    match edits.view(total_original, i) {
                        LineView::Original(orig) => {
                            decode_into(scratch, line_slice(bytes, &index, orig))
                        }
                        LineView::Edited(t) => t,
                    }
                } else {
                    decode_into(scratch, line_slice(bytes, &index, i))
                };
                ui.painter().text(
                    Pos2::new(text_x, cy),
                    Align2::LEFT_CENTER,
                    text,
                    font.clone(),
                    TEXT,
                );
            }

            *top_line_out = top;
        });

    // Drop overlay (drawn over the central panel).
    if app.is_drag_hovered {
        let (rect, _) = ui.allocate_exact_size(ui.min_size(), Sense::hover());
        let painter = ui.painter_at(ui.max_rect());
        painter.rect_filled(
            ui.max_rect(),
            Rounding::same(14.0),
            Color32::from_rgba_premultiplied(0xab, 0xd3, 0x7a, 28),
        );
        painter.rect_stroke(
            ui.max_rect().shrink(4.0),
            Rounding::same(12.0),
            Stroke::new(2.0, ACCENT),
        );
        // Vector download icon above the label (no glyph tofu).
        let icon_center = rect.center() + Vec2::new(0.0, -22.0);
        crate::icons::download(&painter, icon_center, 36.0, TEXT);
        painter.text(
            rect.center() + Vec2::new(0.0, 18.0),
            Align2::CENTER_CENTER,
            "Drop to open",
            FontId::proportional(18.0),
            TEXT,
        );
    }
}

/// Zero-copy slice for line `i` from the index, with its terminator trimmed.
fn line_slice<'a>(bytes: &'a [u8], index: &LineIndex, i: usize) -> &'a [u8] {
    let (start, end) = match index.span(i, bytes.len()) {
        Some(span) => span,
        None => return &[],
    };
    let mut s = &bytes[start..end];
    // Strip a single trailing \n and optional \r (CRLF) for display.
    let mut n = s.len();
    while n > 0 && (s[n - 1] == b'\n' || s[n - 1] == b'\r') {
        n -= 1;
    }
    s = &s[..n];
    s
}

/// Width of the line-number gutter based on the number of digits.
fn gutter_width(total_lines: usize) -> f32 {
    let digits = total_lines.to_string().len().max(3);
    (digits as f32) * 8.5 + GUTTER_PAD_RIGHT + 8.0
}

// ============================ Formatting ============================

/// Human-readable byte size, binary units (MiB/GiB).
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = bytes as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", bytes, UNITS[0])
    } else {
        format!("{:.2} {}", v, UNITS[i])
    }
}

/// Group digits by thousands (e.g. `14,344,391`).
pub fn fmt_thousands(n: u64) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    let len = bytes.len();
    for (idx, b) in bytes.iter().enumerate() {
        if idx != 0 && (len - idx) % 3 == 0 {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}
