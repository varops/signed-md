// Bundles the server into bundle/ for the Docker image: a few files instead of ~700 modules, so a
// container starts in about a third of the time and with a fraction of the CPU. Run from source
// (node src/main.ts) everywhere else. Libraries that only some requests need stay in separate
// chunks that load on first use.
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const outdir = join(server, "bundle");
await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: [join(server, "src", "main.ts")],
  outdir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Native addons, which must load from node_modules. pg-native is an optional pg add-on we never install.
  external: ["better-sqlite3", "@node-rs/argon2", "@firecrawl/anydoc", "pg-native"],
  // Bundled CommonJS libraries call require().
  banner: { js: 'import { createRequire as __smdCreateRequire } from "node:module"; const require = __smdCreateRequire(import.meta.url);' },
  logLevel: "warning",
});
console.log(`Bundled the server into ${outdir}`);
