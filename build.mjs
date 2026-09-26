// Bundle lavista into a single dist/cli.js with every dependency inlined, so installing it pulls in
// no runtime dependencies. In particular the Agent SDK's optional per-platform Claude Code binaries
// (hundreds of MB) are never installed: lavista runs the `claude` already on PATH.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  minify: true,
  platform: "node",
  format: "esm",
  target: "node22.12",
  jsx: "automatic",
  define: {
    // React's development build records a performance.measure() entry, with a diff of the changed
    // props, for every component render. Node keeps those entries forever, so a long run grew by
    // gigabytes. The production build records none, and is a fraction of the size.
    "process.env.NODE_ENV": '"production"',
    // CommonJS dependencies read these, which an ES module has under import.meta instead.
    __filename: "import.meta.filename",
    __dirname: "import.meta.dirname",
  },
  // Ink loads its React DevTools bridge only when DEV=true and the optional react-devtools-core is
  // installed, which it is not for lavista. `define` cannot drop that branch (Ink reads `process`
  // from an import, not the global), so the import is left out of the bundle instead.
  external: ["./devtools.js"],
  // CommonJS dependencies also call require(), which an ES module lacks. (esbuild keeps the entry
  // point's shebang above the banner.)
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  legalComments: "linked",
  logLevel: "warning",
});
