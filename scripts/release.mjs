#!/usr/bin/env node
// Release helper. One version for the whole product, in the root package.json and every package.
//
//   node scripts/release.mjs check          versions agree and CHANGELOG.md has an Unreleased section
//   node scripts/release.mjs version        print the version
//   node scripts/release.mjs bump 1.2.0     set the version everywhere (when cutting rc)
//   node scripts/release.mjs notes          print the Unreleased notes
//   node scripts/release.mjs stamp [date]   turn Unreleased into the version's section, and print its notes
//
// No dependencies: it runs before `pnpm install` in CI.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["package.json", "apps/server/package.json", "packages/core/package.json", "packages/db/package.json", "packages/verify/package.json"];
const CHANGELOG = join(root, "CHANGELOG.md");
const UNRELEASED = "## [Unreleased]";
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const version = () => readJson("package.json").version;

/** The changelog split around the Unreleased section: text before, the notes, and text after. */
function unreleased() {
  const text = readFileSync(CHANGELOG, "utf8");
  const start = text.indexOf(UNRELEASED);
  if (start < 0) fail(`CHANGELOG.md has no "${UNRELEASED}" section`);
  const bodyStart = start + UNRELEASED.length;
  const next = text.indexOf("\n## [", bodyStart);
  const end = next < 0 ? text.length : next + 1;
  return { text, start, bodyStart, end, notes: text.slice(bodyStart, end).trim() };
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "version":
    console.log(version());
    break;

  case "check": {
    const v = version();
    if (!SEMVER.test(v ?? "")) fail(`root package.json version "${v}" is not semver`);
    const off = PACKAGES.filter((p) => readJson(p).version !== v);
    if (off.length) fail(`these packages are not at ${v}: ${off.join(", ")}. Run: node scripts/release.mjs bump ${v}`);
    unreleased();
    console.log(`release: ${v}, all packages agree`);
    break;
  }

  case "bump": {
    if (!SEMVER.test(arg ?? "")) fail("usage: bump <x.y.z>");
    for (const p of PACKAGES) {
      const file = join(root, p);
      const text = readFileSync(file, "utf8");
      if (!/"version": "[^"]*"/.test(text)) fail(`${p} has no version field`);
      writeFileSync(file, text.replace(/"version": "[^"]*"/, `"version": "${arg}"`));
    }
    console.log(`release: version set to ${arg}`);
    break;
  }

  case "notes":
    console.log(unreleased().notes);
    break;

  case "stamp": {
    const v = version();
    const date = arg ?? new Date().toISOString().slice(0, 10);
    const { text, bodyStart, end, notes } = unreleased();
    if (!notes) fail("the Unreleased section is empty: add the changes before releasing");
    if (text.includes(`## [${v}]`)) fail(`CHANGELOG.md already has a section for ${v}: bump the version first`);
    const stamped = `${text.slice(0, bodyStart)}\n\n## [${v}] – ${date}\n\n${notes}\n\n${text.slice(end)}`;
    writeFileSync(CHANGELOG, stamped.replace(/\n{3,}/g, "\n\n"));
    console.log(notes);
    break;
  }

  default:
    fail("usage: check | version | bump <x.y.z> | notes | stamp [date]");
}
