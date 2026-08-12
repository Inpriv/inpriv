// esbuild.config.mjs — bundles the browser client into static/app.js
// Copyright (c) 2026 Aurex Labs — MIT License
//
// Usage:  node esbuild.config.mjs         (one-shot build)
//         node esbuild.config.mjs --watch (rebuild on change)
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const entry = "src/app.js";
const outdir = "static";
const outfile = "static/app.js";

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "iife",
  target: ["es2022", "chrome110", "firefox110", "safari16"],
  platform: "browser",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  treeShaking: true,
  // hash-wasm ships a .wasm binary; load it as a data URL so the bundle is
  // self-contained (no runtime fetch, which the strict CSP would block).
  loader: {
    ".wasm": "dataurl",
  },
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("esbuild: watching src/ → static/app.js");
} else {
  const result = await esbuild.build(options);
  const kb =
    result.outputFiles && result.outputFiles[0]
      ? (result.outputFiles[0].contents.byteLength / 1024).toFixed(1)
      : "?";
  console.log(`esbuild: built static/app.js — ${kb} KB`);
}
