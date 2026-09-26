// Bundle lavista into a single dist/cli.js with every dependency inlined, so installing it pulls in
// no runtime dependencies. In particular the Agent SDK's optional per-platform Claude Code binaries
// (hundreds of MB) are never installed: lavista runs the `claude` already on PATH.
import { build } from "esbuild";
import { rmSync } from "node:fs";

/**
 * Ink connects to React DevTools when DEV is set and react-devtools-core is installed, which it is
 * not for lavista's users. Bundled, its devtools module would be evaluated with everything else, so
 * it is replaced by an empty one.
 */
const withoutInkDevtools = {
  name: "without-ink-devtools",
  setup(build) {
    build.onResolve({ filter: /^\.\/devtools\.js$/ }, ({ importer }) =>
      importer.includes("/node_modules/ink/") ? { path: "ink-devtools", namespace: "empty" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
  },
};

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  jsx: "automatic",
  // React's development build records a performance.measure() entry, with a diff of the changed
  // props, for every component render. Node keeps those entries forever, so a long run grew by
  // gigabytes. The production build records none.
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [withoutInkDevtools],
  // CommonJS dependencies call require() and use __dirname, which an ES module lacks. (esbuild keeps
  // the entry point's shebang above the banner.)
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module";',
      'import { fileURLToPath as __fileURLToPath } from "node:url";',
      'import { dirname as __pathDirname } from "node:path";',
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  legalComments: "linked",
  logLevel: "warning",
});
