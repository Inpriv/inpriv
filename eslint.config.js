export default [{
  ignores: ["**/public/**", "**/test/**", "**/node_modules/**", "**/.wrangler/**"],
}, {
  files: ["**/*.js", "**/*.mjs"],
  rules: { "no-dupe-args": "error", "no-dupe-keys": "error", "no-duplicate-case": "error", "no-unreachable": "error", "no-eval": "error", "no-new-func": "error" },
}];
