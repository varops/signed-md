import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createDocument, getDocument, loadSigners, previewDocument, revokeDocument, sendDocument } from "../src/services/documents.ts";
import { listEvents } from "../src/services/events.ts";
import { listHeld, rejectHeld, releaseHeld } from "../src/services/review.ts";
import { drainJobs } from "../src/worker.ts";
import { testContext } from "./helpers.ts";

const NDA = (n: number) => ({ title: `NDA ${n}`, content: "# NDA\n\n{{a.signature:signature}}", signers: [{ key: "a", name: "A", email: "a@client.example" }] });

async function send(t: Awaited<ReturnType<typeof testContext>>, n: number) {
  const d = await createDocument(t.ctx, t.user, NDA(n));
  return sendDocument(t.ctx, t.user, d.id, { approved_revision: (await previewDocument(t.ctx, t.user, d.id)).revision });
}

describe("review of first sends (REVIEW_SENDS)", () => {
  it("is off by default", async () => {
    const t = await testContext();
    const d = await send(t, 1);
    expect(d.held_for_review).toBe(false);
    expect((await loadSigners(t.ctx.db, d.id))[0]!.status).toBe("notified");
    await t.ctx.close();
  });

  it("holds the first N sends without notifying anyone, then sends normally", async () => {
    const t = await testContext({ REVIEW_SENDS: "2" });
    const first = await send(t, 1);
    const second = await send(t, 2);
    const third = await send(t, 3);
    expect([first.held_for_review, second.held_for_review, third.held_for_review]).toEqual([true, true, false]);
    expect(first.status).toBe("sent");
    expect((await loadSigners(t.ctx.db, first.id))[0]!.status).toBe("pending");
    expect((await loadSigners(t.ctx.db, third.id))[0]!.status).toBe("notified");

    const held = await listHeld(t.ctx);
    expect(held.map((h) => h.id)).toEqual([first.id, second.id]);
    expect(held[0]).toMatchObject({ title: "NDA 1", sent_by: "admin@automaze.example", signers: [{ name: "A", email: "a@client.example" }] });
    expect(held[0]!.content).toContain("# NDA");

    await releaseHeld(t.ctx, first.id);
    expect((await getDocument(t.ctx, t.user, first.id)).held_for_review).toBe(false);
    expect((await loadSigners(t.ctx.db, first.id))[0]!.status).toBe("notified");
    expect((await listEvents(t.ctx.db, first.id)).map((e) => e.type)).toEqual(expect.arrayContaining(["document.sent", "document.held_for_review", "document.review_released", "signer.notified"]));
    await expect(releaseHeld(t.ctx, first.id)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });

    await rejectHeld(t.ctx, second.id, "Looks like credential phishing");
    const rejected = await getDocument(t.ctx, t.user, second.id);
    expect(rejected).toMatchObject({ status: "revoked", held_for_review: false });
    expect((await loadSigners(t.ctx.db, second.id))[0]!.status).toBe("pending");
    expect(await listHeld(t.ctx)).toEqual([]);
    await t.ctx.close();
  });

  it("lets the sender revoke a held document", async () => {
    const t = await testContext({ REVIEW_SENDS: "1" });
    const d = await send(t, 1);
    expect((await revokeDocument(t.ctx, t.user, d.id, "Wrong client")).held_for_review).toBe(false);
    expect(await listHeld(t.ctx)).toEqual([]);
    await t.ctx.close();
  });

  it("tells REVIEW_NOTIFY_URL, with only the document id", async () => {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        bodies.push(b);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const t = await testContext({ REVIEW_SENDS: "1", REVIEW_NOTIFY_URL: `http://127.0.0.1:${port}/hooks/review/acme` });
    const d = await send(t, 1);
    await drainJobs(t.ctx);
    expect(bodies.map((b) => JSON.parse(b))).toEqual([{ document_id: d.id }]);
    await t.ctx.close();
    server.close();
  });
});
