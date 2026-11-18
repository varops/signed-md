import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cookieValue, setCookieHeader } from "../../../sso/signed-md-cookie.ts";
import { sessionActor, sessionCookie } from "../src/services/auth.ts";
import { testContext } from "./helpers.ts";

// The sso/ helpers must write exactly the cookie the server writes and accepts.

const SSO = join(import.meta.dirname, "..", "..", "..", "sso");
const KEY = "a-long-shared-cookie-hash-key-0123456789";
const EMAIL = " Admin@Automaze.example ";
const NOW = Math.floor(Date.now() / 1000);

function has(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    try {
      execFileSync(bin, ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

describe("sso cookie helpers", async () => {
  const { ctx, user } = await testContext({ COOKIE_HASH_KEY: KEY });
  afterAll(() => ctx.close());
  const expected = sessionCookie(ctx, EMAIL.trim(), NOW * 1000);

  it("TypeScript matches the server, and the server accepts it", async () => {
    expect(cookieValue(EMAIL, KEY, NOW)).toBe(expected);
    expect((await sessionActor(ctx, cookieValue(EMAIL, KEY)))?.id).toBe(user.id);
    expect(setCookieHeader(EMAIL, KEY, ".example.com", NOW)).toBe(`smd_session=${expected}; Max-Age=3600; Path=/; Domain=.example.com; HttpOnly; Secure; SameSite=Lax`);
  });

  it.skipIf(!has("python3"))("Python matches", () => {
    const out = execFileSync("python3", ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(SSO)}); from signed_md_cookie import cookie_value; print(cookie_value(${JSON.stringify(EMAIL)}, ${JSON.stringify(KEY)}, ${NOW}))`]).toString().trim();
    expect(out).toBe(expected);
  });

  it.skipIf(!has("php"))("PHP matches", () => {
    const out = execFileSync("php", ["-r", `require ${JSON.stringify(join(SSO, "signed_md_cookie.php"))}; echo signed_md_cookie_value(${JSON.stringify(EMAIL)}, ${JSON.stringify(KEY)}, ${NOW});`]).toString().trim();
    expect(out).toBe(expected);
  });

  it.skipIf(!has("ruby"))("Ruby matches", () => {
    const out = execFileSync("ruby", ["-e", `require ${JSON.stringify(join(SSO, "signed_md_cookie.rb"))}; puts SignedMdCookie.value(${JSON.stringify(EMAIL)}, ${JSON.stringify(KEY)}, ${NOW})`]).toString().trim();
    expect(out).toBe(expected);
  });

  it.skipIf(!has("go"))("Go matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "smd-go-"));
    mkdirSync(join(dir, "signedmdcookie"));
    cpSync(join(SSO, "signedmdcookie.go"), join(dir, "signedmdcookie", "signedmdcookie.go"));
    writeFileSync(join(dir, "go.mod"), "module check\n\ngo 1.21\n");
    writeFileSync(join(dir, "main.go"), `package main\n\nimport (\n\t"fmt"\n\t"check/signedmdcookie"\n)\n\nfunc main() { fmt.Println(signedmdcookie.Value(${JSON.stringify(EMAIL)}, ${JSON.stringify(KEY)}, ${NOW})) }\n`);
    const out = execFileSync("go", ["run", "."], { cwd: dir, env: { ...process.env, GOFLAGS: "-mod=mod" } }).toString().trim();
    expect(out).toBe(expected);
  }, 60_000);
});
