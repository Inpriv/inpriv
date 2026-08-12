//! Inpriv Swift — core library.
//!
//! Zero-copy, memory-mapped text-viewing primitives:
//!   * [`buffer`]  — maps a file read-only and orchestrates background indexing.
//!   * [`indexer`] — SIMD-accelerated line-start index builder.

pub mod anim;
pub mod app;
pub mod buffer;
pub mod icons;
pub mod indexer;
pub mod ui;
