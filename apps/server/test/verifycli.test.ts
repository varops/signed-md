import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../../packages/verify/src/cli.ts";

describe("signed-md verify (command line)", () => {
  const dir = mkdtempSync(join(tmpdir(), "signedmd-verifycli-"));
  const output = () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    return () => [...err.mock.calls, ...log.mock.calls].map((c) => c.join(" ")).join("\n");
  };
  afterEach(() => vi.restoreAllMocks());

  it("explains a missing file instead of crashing", () => {
    const out = output();
    expect(run(["verify", join(dir, "missing.zip")])).toBe(2);
    expect(out()).toContain("no such file");
  });

  it("explains a folder and a missing keys file", () => {
    const out = output();
    expect(run(["verify", dir])).toBe(2);
    writeFileSync(join(dir, "a.zip"), "not a zip");
    expect(run(["verify", join(dir, "a.zip"), "--keys"])).toBe(2);
    expect(run(["verify", join(dir, "a.zip"), "--keys", join(dir, "nokeys.json")])).toBe(2);
    const text = out();
    expect(text).toContain("it is a folder");
    expect(text).toContain("--keys needs a keys file");
    expect(text).toContain("Could not read the keys file");
  });

  it("reports a file that isn't a package as invalid", () => {
    const out = output();
    writeFileSync(join(dir, "b.zip"), "not a zip");
    expect(run(["verify", join(dir, "b.zip")])).toBe(1);
    expect(out()).toContain("INVALID");
  });
});
