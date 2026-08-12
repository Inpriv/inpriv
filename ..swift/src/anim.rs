//! Easing curves and animation helpers.
//!
//! Implements the Aurex Labs M3 "Earthy Forest" motion spec (see aurexlabs.md
//! §7). All curves are physics-flavoured: no linear transitions.

/// Standard M3 easing: `cubic-bezier(0.2, 0.0, 0.0, 1.0)`.
/// Approximated as a smooth ease-out for color / opacity transitions.
pub fn standard(t: f32) -> f32 {
    ease_out_cubic(t)
}

/// Emphasized M3 easing: `cubic-bezier(0.3, 0.0, 0.0, 1.0)`.
pub fn emphasized(t: f32) -> f32 {
    ease_out_quint(t)
}

/// Spring M3 easing: `cubic-bezier(0.2, 1.4, 0.0, 1.0)` — entrances, bouncy.
/// Has a slight overshoot for that "delightful pop".
pub fn spring(t: f32) -> f32 {
    // Bezier with an out-of-range control point produces an overshoot.
    // We approximate the spring feel with an overshooting ease-out.
    let c1 = 1.70158_f32;
    let c3 = c1 + 1.0;
    1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
}

/// Spring-soft M3 easing: `cubic-bezier(0.34, 1.3, 0.64, 1.0)` — subtle bounce.
pub fn spring_soft(t: f32) -> f32 {
    ease_out_back(t, 1.3)
}

// --- Building-block ease functions ---

fn ease_out_cubic(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_quint(t: f32) -> f32 {
    1.0 - (1.0 - t).powi(5)
}

fn ease_out_back(t: f32, overshoot: f32) -> f32 {
    let c1 = overshoot;
    let c3 = c1 + 1.0;
    1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
}

/// Map a 0..1 progress value through a spring curve, clamped.
pub fn spring_progress(progress: f32) -> f32 {
    spring(progress.clamp(0.0, 1.0))
}
