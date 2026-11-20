import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimJob, completeJob, enqueueJob, failJob, migrateToLatest, newId, now, openDatabase, ping, type Db } from "../src/index.ts";

const targets: [string, string | undefined][] = [
  ["sqlite", "sqlite::memory:"],
  ["postgres", process.env.TEST_POSTGRES_URL],
];

for (const [name, url] of targets) {
  describe.skipIf(!url)(`database (${name})`, () => {
    let h: Db;

    beforeAll(async () => {
      h = openDatabase(url!);
      if (h.dialect === "postgres") {
        // Fresh schema for each run.
        await sql`drop schema public cascade`.execute(h.db);
        await sql`create schema public`.execute(h.db);
      }
      await migrateToLatest(h.db);
    });
    afterAll(async () => h?.close());

    it("migrates and pings", async () => {
      expect(await ping(h.db)).toBe(true);
      expect(await migrateToLatest(h.db)).toEqual([]); // idempotent
    });

    it("stores and reads an account", async () => {
      const id = newId("acct");
      await h.db.insertInto("accounts").values({ id, name: "Acme", config: "{}", created_at: now() }).execute();
      const row = await h.db.selectFrom("accounts").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      expect(row.name).toBe("Acme");
    });

    it("runs the job queue with dedupe, retry and crash recovery", async () => {
      const a = await enqueueJob(h.db, "email", { to: "a" }, { dedupeKey: "email:a" });
      const dup = await enqueueJob(h.db, "email", { to: "a" }, { dedupeKey: "email:a" });
      expect(a).toBeTruthy();
      expect(dup).toBeNull();

      const job = await claimJob(h.db, h.dialect);
      expect(job?.id).toBe(a);
      expect(Number(job?.attempts)).toBe(1);
      expect(await claimJob(h.db, h.dialect)).toBeNull(); // locked

      expect(await failJob(h.db, job!, "boom")).toBe("retry");
      expect(await claimJob(h.db, h.dialect)).toBeNull(); // backoff

      // Simulate a crashed worker: running job with an expired lock is reclaimed.
      await h.db.updateTable("jobs").set({ status: "running", locked_until: "2000-01-01T00:00:00.000Z" }).where("id", "=", a!).execute();
      const again = await claimJob(h.db, h.dialect);
      expect(again?.id).toBe(a);
      // The first claim was superseded: it can neither complete nor fail the newer run.
      expect(await completeJob(h.db, job!)).toBe(false);
      expect(await failJob(h.db, job!, "late")).toBe("lost");
      expect(await completeJob(h.db, again!)).toBe(true);
      expect(await completeJob(h.db, again!)).toBe(false); // done is final
      const done = await h.db.selectFrom("jobs").select("status").where("id", "=", a!).executeTakeFirstOrThrow();
      expect(done.status).toBe("done");
    });
  });
}
