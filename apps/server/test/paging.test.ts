import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { createSession } from "../src/services/auth.ts";
import { listActivity } from "../src/services/audit.ts";
import { createDocument, listDocuments } from "../src/services/documents.ts";
import { createFolder } from "../src/services/folders.ts";
import { testContext } from "./helpers.ts";

const inline = (n: number) => ({ title: `Doc ${n}`, content: `# NDA ${n}\n\n{{a.signature:signature}}`, signers: [{ key: "a", name: "Ann", email: `ann${n}@client.example` }] });
const SAME = "2026-01-01T00:00:00.000Z";

describe("pagination", async () => {
  const { ctx, user } = await testContext();
  afterAll(() => ctx.close());
  for (let n = 1; n <= 7; n++) await createDocument(ctx, user, inline(n));
  for (const name of ["A", "B", "C"]) await createFolder(ctx, user, "document", name);
  // Everything at the same millisecond: the cursors must still never skip or repeat a row.
  await ctx.db.updateTable("documents").set({ created_at: SAME }).execute();
  await ctx.db.updateTable("events").set({ created_at: SAME }).execute();
  await ctx.db.updateTable("audit_events").set({ created_at: SAME }).execute();

  it("pages documents older and newer without skipping rows created together", async () => {
    const all = (await listDocuments(ctx, user, { limit: 100 })).data.map((d) => d.id);
    expect(all).toHaveLength(7);
    const pages: string[][] = [];
    let page = await listDocuments(ctx, user, { limit: 3 });
    expect(page.newer_after).toBeNull();
    const cursors: (string | null)[] = [];
    for (;;) {
      pages.push(page.data.map((d) => d.id));
      cursors.push(page.newer_after);
      if (!page.next_before) break;
      page = await listDocuments(ctx, user, { limit: 3, before: page.next_before });
    }
    expect(pages.flat()).toEqual(all);
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);

    // Back from the last page: the middle page, then the first (a short newer page is the first page).
    const back = await listDocuments(ctx, user, { limit: 3, after: cursors[2]! });
    expect(back.data.map((d) => d.id)).toEqual(pages[1]);
    const first = await listDocuments(ctx, user, { limit: 3, after: back.newer_after! });
    expect(first.data.map((d) => d.id)).toEqual(pages[0]);
    expect(first.newer_after).toBeNull();
  });

  it("pages the merged activity list the same way", async () => {
    const all = (await listActivity(ctx.db, { limit: 200 })).items;
    expect(all.length).toBeGreaterThanOrEqual(10); // 7 drafts and 3 folders
    const seen: typeof all = [];
    let page = await listActivity(ctx.db, { limit: 4 });
    expect(page.newer).toBeNull();
    const newerCursors: (string | null)[] = [];
    for (;;) {
      seen.push(...page.items);
      newerCursors.push(page.newer);
      if (!page.older) break;
      page = await listActivity(ctx.db, { limit: 4, before: page.older });
    }
    expect(seen).toEqual(all);
    const second = await listActivity(ctx.db, { limit: 4, after: newerCursors[2]! });
    expect(second.items).toEqual(seen.slice(4, 8));
  });

  it("shows Newer and Older links that keep the filters", async () => {
    const token = await createSession(ctx, user.id);
    const app = createApp(ctx);
    const get = async (url: string) => (await app.request(url, { headers: { cookie: `smd_session=${token}` } })).text();
    const first = await get("/activity");
    expect(first).not.toContain("Newer");
    const activityOlder = first.match(/href="(\/activity\?before=[^"]+)"/)?.[1];
    expect(activityOlder).toBeUndefined(); // 10+ events fit on one page of 50
    for (let n = 8; n <= 30; n++) await createDocument(ctx, user, inline(n));
    const docs = await get("/documents?q=doc");
    const older = docs.match(/href="(\/documents\?[^"]*before=[^"]+)"[^>]*rel="next"/)?.[1];
    expect(older).toBeDefined();
    expect(older!.replace(/&amp;/g, "&")).toContain("q=doc");
    const page2 = await get(older!.replace(/&amp;/g, "&"));
    expect(page2).toContain('rel="prev"');
    expect(page2).not.toContain('class="folders'); // no folder cards past the first page
  });
});
