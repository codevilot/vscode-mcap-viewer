// Verify a packaged .vsix can actually load its declared entrypoint.
// Catches .vscodeignore footguns that strip files some bundled node_module
// declares as its `main` (e.g. node_modules/.../src/index.js getting filtered
// by a `node_modules/**/src/**` rule).
//
// Usage:
//   node scripts/verify-vsix.js mcap-viewer-X.Y.Z.vsix

const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const vsixArg = process.argv[2];
if (!vsixArg) {
  console.error("Usage: node scripts/verify-vsix.js <path-to.vsix>");
  process.exit(2);
}
const vsixPath = resolve(vsixArg);
if (!existsSync(vsixPath)) {
  console.error(`vsix not found: ${vsixPath}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "mcap-vsix-verify-"));
try {
  execFileSync("unzip", ["-q", vsixPath, "-d", work]);
  const root = join(work, "extension");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const main = pkg.main || "./extension.js";
  const mainPath = resolve(root, main);
  if (!existsSync(mainPath)) {
    console.error(`FAIL: extension main not present in vsix: ${main}`);
    process.exit(1);
  }

  // Try to require the extension main. If any transitive require fails (e.g.
  // a bundled node_module's main has been stripped), this throws here.
  // Use a child node so a failure cleanly produces a non-zero exit code.
  // The 'vscode' module isn't real outside the extension host, so we shim it
  // via Module._resolveFilename + a tiny stub on disk.
  const shimPath = join(work, "vscode-shim.js");
  require("node:fs").writeFileSync(
    shimPath,
    "module.exports = new Proxy({}, { get: () => () => undefined });\n",
  );
  const loader = [
    "const Module = require('module');",
    "const origResolve = Module._resolveFilename;",
    `Module._resolveFilename = function(req, parent, ...rest) {`,
    "  if (req === 'vscode') return " + JSON.stringify(shimPath) + ";",
    "  return origResolve.call(this, req, parent, ...rest);",
    "};",
    `require(${JSON.stringify(mainPath)});`,
  ].join("\n");
  try {
    execFileSync(
      "node",
      ["-e", loader],
      { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" },
    );
  } catch (error) {
    const stderr = error.stderr?.toString() ?? "";
    console.error("FAIL: require(extension main) threw inside the packaged vsix.");
    console.error("This usually means .vscodeignore stripped a file some bundled");
    console.error("node_modules package declares as its main entrypoint.");
    console.error("");
    console.error(stderr.trim());
    process.exit(1);
  }

  console.log(`OK: ${pkg.name}@${pkg.version} main loads cleanly (${main})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
