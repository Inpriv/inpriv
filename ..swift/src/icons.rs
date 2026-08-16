//! Vector-drawn UI icons.
//!
//! egui's bundled fonts lack the emoji/symbol glyphs (🔍 ⤓ ✕ ▲ ▼ ◆), which
//! would render as "tofu" boxes. Instead, every icon is drawn directly with
//! the painter as crisp vector geometry — zero binary weight, DPI-independent,
//! and tinted by the caller so icons inherit the active theme color.

use egui::{Color32, Painter, Pos2, Rect, Rounding, Shape, Stroke, Vec2};

/// Diamond (◆) — the brand mark. A filled rotated square.
pub fn diamond(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let h = size * 0.5;
    let points = [
        Pos2::new(center.x, center.y - h),
        Pos2::new(center.x + h, center.y),
        Pos2::new(center.x, center.y + h),
        Pos2::new(center.x - h, center.y),
    ];
    painter.add(Shape::convex_polygon(points.to_vec(), color, Stroke::NONE));
}

/// Magnifier (🔍) — a circle with a short handle, drawn as stroke.
pub fn search(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let lens_r = size * 0.28;
    let lens_center = center + Vec2::new(-size * 0.08, -size * 0.08);
    painter.circle_stroke(lens_center, lens_r, Stroke::new(size * 0.09, color));
    // Handle: from lower-right of the lens outward.
    let dir = Vec2::new(1.0, 1.0).normalized();
    let start = lens_center + dir * (lens_r * 0.75);
    let end = center + dir * (size * 0.42);
    painter.line_segment([start, end], Stroke::new(size * 0.11, color));
}

/// Up chevron (▲) — previous match.
pub fn chevron_up(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let h = size * 0.45;
    let w = size * 0.40;
    let points = [
        Pos2::new(center.x, center.y - h),
        Pos2::new(center.x + w, center.y + h * 0.4),
        Pos2::new(center.x - w, center.y + h * 0.4),
    ];
    painter.add(Shape::convex_polygon(points.to_vec(), color, Stroke::NONE));
}

/// Down chevron (▼) — next match.
pub fn chevron_down(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let h = size * 0.45;
    let w = size * 0.40;
    let points = [
        Pos2::new(center.x, center.y + h),
        Pos2::new(center.x + w, center.y - h * 0.4),
        Pos2::new(center.x - w, center.y - h * 0.4),
    ];
    painter.add(Shape::convex_polygon(points.to_vec(), color, Stroke::NONE));
}

/// Close (✕) — two crossed strokes.
pub fn close(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let h = size * 0.38;
    let stroke = Stroke::new(size * 0.10, color);
    painter.line_segment(
        [
            Pos2::new(center.x - h, center.y - h),
            Pos2::new(center.x + h, center.y + h),
        ],
        stroke,
    );
    painter.line_segment(
        [
            Pos2::new(center.x + h, center.y - h),
            Pos2::new(center.x - h, center.y + h),
        ],
        stroke,
    );
}

/// Download / drop arrow (⤓) — a downward arrow with a small tray.
pub fn download(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let stroke = Stroke::new(size * 0.08, color);
    // Shaft of the arrow.
    let top = center + Vec2::new(0.0, -size * 0.42);
    let mid = center + Vec2::new(0.0, size * 0.05);
    painter.line_segment([top, mid], stroke);
    // Arrowhead.
    let hw = size * 0.26;
    painter.line_segment([mid, mid + Vec2::new(-hw, -hw * 0.6)], stroke);
    painter.line_segment([mid, mid + Vec2::new(hw, -hw * 0.6)], stroke);
    // Tray (a short horizontal line beneath).
    let tray_y = center.y + size * 0.40;
    let tw = size * 0.42;
    painter.line_segment(
        [
            Pos2::new(center.x - tw, tray_y),
            Pos2::new(center.x + tw, tray_y),
        ],
        stroke,
    );
}

/// Filled dot — used for the "ready"/"failed" status pill.
pub fn dot(painter: &Painter, center: Pos2, r: f32, color: Color32) {
    painter.circle_filled(center, r, color);
}

/// Pencil (✎) — edit-mode toggle. A diagonal shaft with a chiseled tip.
pub fn pencil(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let s = size * 0.5;
    let d = Vec2::new(1.0, -1.0).normalized(); // shaft direction (tip → end)
    let n = Vec2::new(1.0, 1.0).normalized(); // shaft normal
    let half = s * 0.16;
    let tip = center - d * s * 0.9;
    let end = center + d * s * 0.9;
    let stroke = Stroke::new(size * 0.09, color);
    // Two long shaft edges + the end cap.
    painter.line_segment([tip + n * half, end + n * half], stroke);
    painter.line_segment([tip - n * half, end - n * half], stroke);
    painter.line_segment([end + n * half, end - n * half], stroke);
    // Chiseled tip: two edges converging on the point.
    let base = d * half * 2.2;
    painter.line_segment([tip, tip + n * half + base], stroke);
    painter.line_segment([tip, tip - n * half + base], stroke);
}

/// Floppy disk (💾) — save. Stroked outer square with shutter + label slots.
pub fn save(painter: &Painter, center: Pos2, size: f32, color: Color32) {
    let half = size * 0.38;
    let stroke = Stroke::new(size * 0.09, color);
    let rounding = Rounding::same(size * 0.07);
    let r = Rect::from_center_size(center, Vec2::splat(half * 2.0));
    painter.rect_stroke(r, rounding, stroke);
    // Metal shutter (top-left).
    let shutter = Rect::from_min_size(
        Pos2::new(r.left() + half * 0.35, r.top() + half * 0.15),
        Vec2::new(half * 0.6, half * 0.55),
    );
    painter.rect_stroke(shutter, Rounding::same(1.0), stroke);
    // Label slot (bottom).
    let label = Rect::from_min_size(
        Pos2::new(r.left() + half * 0.35, r.top() + half * 1.0),
        Vec2::new(half * 1.3, half * 0.65),
    );
    painter.rect_stroke(label, Rounding::same(1.0), stroke);
}
