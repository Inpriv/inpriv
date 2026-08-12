//! Inpriv Swift — entry point.
//!
//! Launches the eframe window. If a file path is passed on the command line it
//! is opened immediately; otherwise the app starts in the empty/drop state.

use eframe::egui::{IconData, Vec2, ViewportBuilder};

use inpriv_swift::app::App;

/// The window icon, embedded at compile time so the binary is self-contained.
const ICON_PNG: &[u8] = include_bytes!("../assets/icon.png");

fn main() -> eframe::Result {
    // Capture a CLI-provided path (if any) before handing control to eframe.
    let initial_path = std::env::args_os().nth(1).map(std::path::PathBuf::from);

    let window_size = Vec2::new(1180.0, 760.0);

    let icon = load_icon(ICON_PNG);

    let viewport = ViewportBuilder::default()
        .with_inner_size(window_size)
        .with_min_inner_size(Vec2::new(640.0, 400.0))
        .with_title("Inpriv Swift");
    let viewport = if let Some(icon) = icon {
        viewport.with_icon(icon)
    } else {
        viewport
    };

    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    eframe::run_native(
        "Inpriv Swift",
        options,
        Box::new(move |cc| {
            let mut app = App::new(cc);
            if let Some(path) = initial_path {
                app.open_path(path);
            }
            Ok(Box::new(app))
        }),
    )
}

/// Decode an embedded PNG into egui's `IconData` (RGBA). Returns `None` on any
/// decode failure — the window then simply has no custom icon.
fn load_icon(png: &[u8]) -> Option<IconData> {
    let img = image::load_from_memory(png).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    Some(IconData {
        rgba: img.into_raw(),
        width: w,
        height: h,
    })
}
