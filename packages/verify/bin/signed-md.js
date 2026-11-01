#!/usr/bin/env node
// Published packages run the bundled build. In this repository, Node runs the TypeScript sources directly.
import { existsSync } from "node:fs";
const bundled = new URL("../dist/cli.js", import.meta.url);
const { run } = existsSync(bundled) ? await import(bundled.href) : await import("../src/cli.ts");
process.exitCode = run(process.argv.slice(2));
