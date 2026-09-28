// Smoke test: every server module must load without executing a query.
const fs = require("fs");
const path = require("path");

// Anchored to the repo root, not to this file's own directory, so `require`
// below resolves the way it would from index.js.
const ROOT = path.resolve(__dirname, "..");

const walk = (d) =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  );

const DIRS = [
  "src/models",
  "src/controllers",
  "src/services",
  "src/lib",
  "src/utils",
  "src/config",
  "src/middleware",
];

let bad = 0;
let n = 0;
for (const dir of DIRS) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) continue;
  for (const f of walk(abs).filter((f) => f.endsWith(".js"))) {
    n++;
    try {
      require(f);
    } catch (e) {
      bad++;
      console.log("  FAIL " + path.relative(ROOT, f) + " :: " + String(e.message).split("\n")[0]);
    }
  }
}
console.log(bad ? "  " + bad + "/" + n + " failed" : "  all " + n + " files load cleanly");
process.exit(bad ? 1 : 0);
