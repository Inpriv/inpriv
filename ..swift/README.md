# Inpriv Swift

> Ultra-fast, minimal text editor/viewer for massive files. Built in Rust.

Part of [Inpriv](https://inpriv.xyz) — zero-knowledge privacy utilities by [Inpriv Labs](https://inpriv.xyz).

## What it does

Inpriv Swift is a native desktop text editor engineered for opening and navigating files that crash conventional editors — log files, data exports, large codebases. It uses memory-mapped I/O and SIMD-accelerated line scanning for instant performance on multi-gigabyte files.

## Features

- **Zero-copy I/O** — memory-mapped file reading (`memmap2`), no full-file load into RAM
- **SIMD line scanning** — `memchr` uses CPU SIMD instructions to scan for newlines at memory bandwidth speed
- **Optional edit mode** — turn editing on with `Ctrl+E`; edits live in a lightweight overlay, never copying the file into RAM
- **Immediate-mode GUI** — built with `eframe`/`egui` for 60fps rendering
- **Native file dialogs** — drag & drop and system file picker via `rfd`
- **Minimal memory footprint** — only visible lines are rendered
- **Self-contained binary** — window icon embedded at compile time

## How it works

1. Files are opened via `memmap2` — the OS maps the file into virtual memory without reading it all
2. `memchr` uses CPU SIMD instructions to scan for newlines at memory bandwidth speed
3. An indexer builds a line-offset table lazily as you scroll
4. `egui` renders only the visible viewport — thousands of lines scroll smoothly

### Edit mode (optional)

Editing is **off by default** — the app behaves as a pure read-only viewer until you enable it.

- **`Ctrl+E`** (or the pencil button) toggles edit mode
- **Click a line** to edit it inline
- **`Enter`** commits and moves to the next line (appending at EOF)
- **`Ctrl+Enter`** inserts a new line below
- **`Ctrl+D`** deletes the current line
- **`Esc`** commits and leaves the inline editor
- **`Ctrl+S`** (or the save button) writes the file

Edits are stored as a line-granular overlay (a piece table keyed by original line index) on top of the read-only memory map — browsing a 10 GB file with a hundred edits costs the same as browsing it read-only, and only the lines you touched are held in RAM. Saving streams the merged content (original byte slices + edited lines, preserving CRLF/LF) into a temp file next to the original, then swaps it in and reindexes — the file is never loaded wholesale into memory. Leaving edit mode with unsaved changes asks for confirmation first.

## Build

```bash
cd ..swift
cargo build --release
# Binary: target/release/inpriv-swift
```

### Run

```bash
# Open a file
./target/release/inpriv-swift /path/to/huge-file.log

# Or launch empty and drag & drop
./target/release/inpriv-swift
```

## Architecture

```
src/
├── main.rs     — entry point, CLI arg parsing, eframe window setup
├── lib.rs      — module declarations
├── app.rs      — application state and event loop
├── buffer.rs   — memory-mapped buffer management
├── edit.rs     — optional editing overlay + streaming save
├── indexer.rs  — line offset indexing
├── ui.rs       — egui rendering and interaction
├── icons.rs    — UI icon handling
└── anim.rs     — UI animations
```

## Security

- ✅ No network access — fully offline
- ✅ Read-only by default; edit mode writes only when you explicitly save (Ctrl+S)
- ✅ No telemetry or crash reporting

## Tech

- Rust 2021 edition (MSRV 1.80)
- `eframe` 0.29 / `egui` 0.29 — immediate-mode GUI
- `memmap2` 0.9 — memory-mapped I/O
- `memchr` 2.7 — SIMD-accelerated byte scanning
- `rfd` 0.15 — native file dialogs
