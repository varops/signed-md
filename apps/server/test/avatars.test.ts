import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { avatarUrl, emailAvatar } from "../src/services/avatars.ts";

describe("avatars", async () => {
  const png = readFileSync(join(import.meta.dirname, "fixtures", "avatar.png"));
  const hits: string[] = [];
  // Behaves like unavatar.io with fallback=false.
  const server = createServer((req, res) => {
    const path = decodeURIComponent(req.url ?? "");
    hits.push(path);
    if (path.startsWith("/known@")) res.writeHead(200, { "content-type": "image/png" }).end(png);
    else if (path.startsWith("/logo@")) res.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg/>");
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const config = loadConfig({ UNAVATAR_DOMAIN: `http://localhost:${(server.address() as AddressInfo).port}` });

  it("falls back to an initials image from ui-avatars.com, in colours that stay the same per person", () => {
    const url = avatarUrl(config, true, "Known@X.example", "Kim Known")!;
    const fallback = new URL(decodeURIComponent(new URL(url).searchParams.get("fallback")!));
    expect(fallback.origin).toBe("https://ui-avatars.com");
    expect(fallback.searchParams.get("name")).toBe("Kim Known");
    expect(fallback.searchParams.get("background")).toMatch(/^[0-9A-F]{6}$/);
    expect(avatarUrl(config, true, "known@x.example", "Kim Known")).toBe(url);
    expect(new URL(avatarUrl(config, true, "jo@x.example")!).searchParams.get("fallback")).toContain("name=jo");
    const colours = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => new URL(new URL(avatarUrl(config, true, `${n}@x.example`)!).searchParams.get("fallback")!).searchParams.get("background")));
    expect(colours.size).toBeGreaterThan(1);
  });

  it("uses an avatar in emails only when a real PNG, JPEG or GIF exists", async () => {
    expect(await emailAvatar(config, true, "known@x.example")).toContain("known%40x.example");
    expect(await emailAvatar(config, true, "nobody@x.example")).toBeNull();
    expect(await emailAvatar(config, true, "logo@x.example")).toBeNull(); // SVG: Gmail and Outlook can't show it
    expect(await emailAvatar(config, false, "known@x.example")).toBeNull();
  });

  it("checks each address once, then remembers", async () => {
    const before = hits.length;
    await emailAvatar(config, true, "known@x.example");
    await emailAvatar(config, true, "nobody@x.example");
    expect(hits.length).toBe(before);
  });

  it("falls back to initials when the avatar service can't be reached", async () => {
    const down = loadConfig({ UNAVATAR_DOMAIN: "http://localhost:1" });
    expect(await emailAvatar(down, true, "known@x.example")).toBeNull();
  });

  it("can use Gravatar instead, with a hash of the email and a 404 for people without an account", () => {
    const g = loadConfig({ AVATAR_PROVIDER: "gravatar" });
    expect(avatarUrl(g, true, " Jane@Acme.example ")).toBe(`https://gravatar.com/avatar/${createHash("sha256").update("jane@acme.example").digest("hex")}?d=404&s=128`);
    expect(loadConfig({ AVATAR_PROVIDER: "gravatar", GRAVATAR_DOMAIN: "avatars.signed.md" }).avatarBaseUrl).toBe("https://avatars.signed.md/avatar");
    expect(loadConfig({ UNAVATAR_DOMAIN: "avatars.signed.md" }).avatarBaseUrl).toBe("https://avatars.signed.md");
    expect(loadConfig({}).avatarBaseUrl).toBe("https://unavatar.io");
    expect(() => loadConfig({ AVATAR_PROVIDER: "libravatar" })).toThrow(/unavatar or gravatar/);
    expect(() => loadConfig({ UNAVATAR_DOMAIN: "http://cdn.example.com" })).toThrow(/UNAVATAR_DOMAIN/);
  });

  it("adds a publishable unavatar key as ?token=, and refuses secret keys", () => {
    const withKey = loadConfig({ UNAVATAR_TOKEN: "pk_test123" });
    const url = new URL(avatarUrl(withKey, true, "jane@acme.example", "Jane Doe")!);
    expect(url.searchParams.get("token")).toBe("pk_test123");
    expect(url.searchParams.get("fallback")).toContain("ui-avatars.com");
    expect(avatarUrl(loadConfig({}), true, "jane@acme.example")).not.toContain("token=");
    expect(avatarUrl(loadConfig({ AVATAR_PROVIDER: "gravatar", UNAVATAR_TOKEN: "pk_x" }), true, "jane@acme.example")).not.toContain("token=");
    expect(() => loadConfig({ UNAVATAR_TOKEN: "sk_secret" })).toThrow(/publishable key/);
  });
});
