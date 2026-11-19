import { SignedError } from "@signed-md/core";
import { type Database, newId, now } from "@signed-md/db";
import type { Kysely } from "kysely";
import type { Actor, Ctx } from "../context.ts";
import { getAccount } from "./accounts.ts";
import { recordAudit } from "./audit.ts";
import { type Permission, requirePermission } from "./permissions.ts";

/**
 * Folders organise templates and documents, one level deep. They are not a permission boundary:
 * members still see only their own documents, whatever folder they are in. Deleting a folder moves
 * what is in it to the top level. The folder's row is kept (with `archived_at`), as with everything else.
 */
export type FolderKind = "template" | "document";

export interface FolderView {
  id: string;
  kind: FolderKind;
  name: string;
  created_at: string;
}

/** Template folders are managed by owners and administrators; document folders by anyone who can create documents. */
const MANAGE: Record<FolderKind, Permission> = { template: "templates.manage", document: "documents.create" };

function view(row: Database["folders"]): FolderView {
  return { id: row.id, kind: row.kind, name: row.name, created_at: row.created_at };
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) throw new SignedError("INVALID_REQUEST", "Folder name is required", [{ code: "INVALID_REQUEST", field: "name", message: "Required" }]);
  if (n.length > 80) throw new SignedError("INVALID_REQUEST", "Folder name must be at most 80 characters");
  return n;
}

export function checkKind(kind: string): FolderKind {
  if (kind !== "template" && kind !== "document") throw new SignedError("INVALID_REQUEST", 'Folder kind must be "template" or "document"');
  return kind;
}

export async function listFolders(ctx: Ctx, kind: FolderKind): Promise<FolderView[]> {
  const rows = await ctx.db.selectFrom("folders").selectAll().where("kind", "=", kind).where("archived_at", "is", null).orderBy("name").execute();
  return rows.map(view);
}

/** A folder that hasn't been deleted. */
export async function getFolder(ctx: Ctx, id: string, db: Kysely<Database> = ctx.db): Promise<FolderView> {
  const row = await db.selectFrom("folders").selectAll().where("id", "=", id).where("archived_at", "is", null).executeTakeFirst();
  if (!row) throw new SignedError("NOT_FOUND", `Folder ${id} does not exist`);
  return view(row);
}

/** A folder id to file something in: it must exist and hold the right kind. */
export async function folderFor(ctx: Ctx, kind: FolderKind, id: string | null | undefined, db: Kysely<Database> = ctx.db): Promise<string | null> {
  if (id === undefined || id === null || id === "") return null;
  const f = await getFolder(ctx, id, db);
  if (f.kind !== kind) throw new SignedError("INVALID_REQUEST", `Folder ${id} holds ${f.kind}s, not ${kind}s`);
  return f.id;
}

/**
 * How many active templates or documents each folder holds. For documents, `ownerId` limits the
 * count to one person's documents (members see only their own).
 */
export async function folderCounts(ctx: Ctx, kind: FolderKind, ownerId?: string): Promise<Map<string, number>> {
  const rows =
    kind === "template"
      ? await ctx.db.selectFrom("templates").select(["folder_id", (eb) => eb.fn.countAll<number | string>().as("n")]).where("archived_at", "is", null).where("folder_id", "is not", null).groupBy("folder_id").execute()
      : await (ownerId === undefined ? ctx.db.selectFrom("documents") : ctx.db.selectFrom("documents").where("owner_user_id", "=", ownerId))
          .select(["folder_id", (eb) => eb.fn.countAll<number | string>().as("n")]).where("archived_at", "is", null).where("folder_id", "is not", null).groupBy("folder_id").execute();
  return new Map(rows.map((r) => [r.folder_id!, Number(r.n)]));
}

async function nameTaken(ctx: Ctx, kind: FolderKind, name: string, except?: string): Promise<boolean> {
  const rows = await ctx.db.selectFrom("folders").select(["id", "name"]).where("kind", "=", kind).where("archived_at", "is", null).execute();
  return rows.some((r) => r.id !== except && r.name.toLowerCase() === name.toLowerCase());
}

export async function createFolder(ctx: Ctx, actor: Actor, kind: FolderKind, name: string): Promise<FolderView> {
  requirePermission(actor, MANAGE[kind]);
  const clean = cleanName(name);
  if (await nameTaken(ctx, kind, clean)) throw new SignedError("INVALID_REQUEST", `There is already a ${kind} folder called "${clean}"`);
  const row = { id: newId("fld"), account_id: (await getAccount(ctx)).id, kind, name: clean, created_at: now(), archived_at: null };
  await ctx.db.insertInto("folders").values(row).execute();
  await recordAudit(ctx.db, actor, "folder.created", { kind, name: clean });
  return view(row);
}

export async function renameFolder(ctx: Ctx, actor: Actor, id: string, name: string): Promise<FolderView> {
  const f = await getFolder(ctx, id);
  requirePermission(actor, MANAGE[f.kind]);
  const clean = cleanName(name);
  if (clean === f.name) return f;
  if (await nameTaken(ctx, f.kind, clean, id)) throw new SignedError("INVALID_REQUEST", `There is already a ${f.kind} folder called "${clean}"`);
  await ctx.db.updateTable("folders").set({ name: clean }).where("id", "=", id).execute();
  await recordAudit(ctx.db, actor, "folder.renamed", { kind: f.kind, from: f.name, name: clean });
  return getFolder(ctx, id);
}

/**
 * Delete a folder. Everything in it (archived items too) moves to the top level; nothing else is
 * touched. The folder's row stays, marked with `archived_at`, so the audit trail still makes sense.
 */
export async function deleteFolder(ctx: Ctx, actor: Actor, id: string): Promise<{ folder: FolderView; moved: number }> {
  const f = await getFolder(ctx, id);
  requirePermission(actor, MANAGE[f.kind]);
  const moved = await ctx.db.transaction().execute(async (trx) => {
    const res =
      f.kind === "template"
        ? await trx.updateTable("templates").set({ folder_id: null }).where("folder_id", "=", id).executeTakeFirst()
        : await trx.updateTable("documents").set({ folder_id: null }).where("folder_id", "=", id).executeTakeFirst();
    await trx.updateTable("folders").set({ archived_at: now() }).where("id", "=", id).execute();
    await recordAudit(trx, actor, "folder.deleted", { kind: f.kind, name: f.name, moved: Number(res.numUpdatedRows) });
    return Number(res.numUpdatedRows);
  });
  return { folder: f, moved };
}

/** Names of the given folders, for list views. */
export async function folderNames(ctx: Ctx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await ctx.db.selectFrom("folders").select(["id", "name"]).where("id", "in", wanted).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}
