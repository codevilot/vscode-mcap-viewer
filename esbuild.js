const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function run() {
  const shared = {
    bundle: true,
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    logLevel: "info",
    target: "es2022",
  };

  const extension = {
    ...shared,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: [
      "vscode",
      "@mcap/core",
      "@mcap/nodejs",
      "@mcap/support",
      "@foxglove/cdr",
      "@foxglove/wasm-bz2",
      "@foxglove/wasm-lz4",
      "@foxglove/wasm-zstd",
    ],
  };

  const webview = {
    ...shared,
    entryPoints: ["webview/main.ts"],
    outfile: "dist/webview.js",
    platform: "browser",
    format: "iife",
  };

  if (watch) {
    const ctx1 = await esbuild.context(extension);
    const ctx2 = await esbuild.context(webview);
    await Promise.all([ctx1.watch(), ctx2.watch()]);
    return;
  }

  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
