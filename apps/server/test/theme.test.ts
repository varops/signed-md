import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { csrfToken, login, sessionActor } from "../src/services/auth.ts";
import { updateProfile } from "../src/services/team.ts";
import { testContext } from "./helpers.ts";

describe("admin theme", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());
  const app = createApp(ctx);

  it("saves a personal theme and renders the admin with it", async () => {
    const s = (await login(ctx, "admin@automaze.example", "correct horse battery"))!;
    expect((await sessionActor(ctx, s.token))!.theme).toBe("system");
    await updateProfile(ctx, user, { name: "Ada Owner", theme: "dark" });
    expect((await sessionActor(ctx, s.token))!.theme).toBe("dark");
    const page = await (await app.request("/documents", { headers: { cookie: `smd_session=${s.token}` } })).text();
    expect(page).toContain('<meta name="color-scheme" content="dark">');
    await updateProfile(ctx, user, { name: "Ada Owner", theme: "light" });
    const light = await (await app.request("/settings", { headers: { cookie: `smd_session=${s.token}` } })).text();
    expect(light).toContain('<meta name="color-scheme" content="light">');
    expect(light).toMatch(/name="theme" value="light"\s+checked/);
  });

  it("saves the theme on its own, keeping the name", async () => {
    const s = (await login(ctx, "admin@automaze.example", "correct horse battery"))!;
    const res = await app.request("/settings/theme", { method: "POST", headers: { cookie: `smd_session=${s.token}`, accept: "application/json" }, body: new URLSearchParams({ _csrf: csrfToken(ctx, s.token), theme: "dark" }) });
    expect(await res.json()).toEqual({ ok: true });
    const actor = (await sessionActor(ctx, s.token))!;
    expect(actor.theme).toBe("dark");
    expect(actor.name).toBe("Ada Owner");
  });

  it("leaves public pages on the device setting", async () => {
    const page = await (await app.request("/s/not-a-real-token-but-long-enough-xxxx")).text();
    expect(page).toContain('<meta name="color-scheme" content="light dark">');
  });

  it("rejects other values", async () => {
    await expect(updateProfile(ctx, user, { name: "Ada Owner", theme: "sepia" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
