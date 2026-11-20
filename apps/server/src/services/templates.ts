import { parseTemplate, SignedError, type FieldDef, templateVersionMachine, type TemplateVersionStatus } from "@signed-md/core";
import { newId, now } from "@signed-md/db";
import { type Actor, actorRef, actorVia, type Ctx } from "../context.ts";
import { recordAudit } from "./audit.ts";
import { can, requirePermission } from "./permissions.ts";
import { folderFor, folderNames } from "./folders.ts";
import { sha256 } from "../crypto.ts";

export interface TemplateInput {
  name: string;
  description?: string;
  source: string;
  /** A template folder to file it in (new templates only). */
  folder_id?: string | null;
}

export interface TemplateVersionView {
  version: number;
  approval_status: TemplateVersionStatus;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  content_hash: string;
}

export interface TemplateView {
  id: string;
  name: string;
  description: string;
  created_via: string;
  current_version: number;
  /** Latest approved version, used by default for new documents. Null until a human approves one. */
  approved_version: number | null;
  archived: boolean;
  folder: { id: string; name: string } | null;
  created_at: string;
  versions: TemplateVersionView[];
}

export interface TemplateVersionDetail extends TemplateVersionView {
  template_id: string;
  source: string;
  fields: FieldDef[];
}

function checkSource(source: string): FieldDef[] {
  if (source.length > 500_000) throw new SignedError("TEMPLATE_INVALID", "Template is too large (max 500 KB)");
  const parsed = parseTemplate(source);
  if (parsed.issues.length > 0) throw new SignedError("TEMPLATE_INVALID", "The template has errors", parsed.issues);
  if (parsed.body.trim() === "") throw new SignedError("TEMPLATE_INVALID", "The template is empty");
  return parsed.fields;
}

/**
 * Create a template. Versions created through the API or MCP start as pending_approval.
 * A human in the UI may create and approve in one step (`approve: true`).
 */
export async function createTemplate(ctx: Ctx, actor: Actor, input: TemplateInput & { approve?: boolean }): Promise<TemplateView> {
  requirePermission(actor, "templates.create");
  const fields = checkSource(input.source);
  const name = input.name.trim();
  if (!name) throw new SignedError("INVALID_REQUEST", "Template name is required", [{ code: "INVALID_REQUEST", field: "name", message: "Required" }]);
  const approve = input.approve === true && actor.kind !== "apikey" && can(actor, "templates.approve");
  const id = newId("tpl");
  const t = now();
  const folderId = await folderFor(ctx, "template", input.folder_id);
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("templates")
      .values({
        id,
        account_id: accountIdOf(actor),
        name,
        description: input.description?.trim() ?? "",
        folder_id: folderId,
        current_version: 1,
        created_via: actorVia(actor),
        created_at: t,
        archived_at: null,
      })
      .execute();
    await trx
      .insertInto("template_versions")
      .values({
        id: newId("tv"),
        template_id: id,
        version: 1,
        source: input.source,
        field_schema: JSON.stringify(fields),
        content_hash: sha256(input.source),
        created_by: actorRef(actor),
        approval_status: approve ? "approved" : "pending_approval",
        approved_by: approve ? actorRef(actor) : null,
        approved_at: approve ? t : null,
        created_at: t,
      })
      .execute();
  });
  await recordAudit(ctx.db, actor, "template.created", { name, approved: approve });
  if (approve) await recordAudit(ctx.db, actor, "template.approved", { name, version: 1 });
  return getTemplate(ctx, id);
}

export async function addTemplateVersion(
  ctx: Ctx,
  actor: Actor,
  templateId: string,
  input: { source: string; name?: string; description?: string; approve?: boolean },
): Promise<TemplateView> {
  requirePermission(actor, "templates.create");
  const fields = checkSource(input.source);
  const approve = input.approve === true && actor.kind !== "apikey" && can(actor, "templates.approve");
  const t = now();
  let created = 0;
  await ctx.db.transaction().execute(async (trx) => {
    const tpl = await trx.selectFrom("templates").selectAll().where("id", "=", templateId).executeTakeFirst();
    if (!tpl) throw new SignedError("TEMPLATE_NOT_FOUND", `Template ${templateId} does not exist`);
    const version = Number(tpl.current_version) + 1;
    created = version;
    await trx
      .insertInto("template_versions")
      .values({
        id: newId("tv"),
        template_id: templateId,
        version,
        source: input.source,
        field_schema: JSON.stringify(fields),
        content_hash: sha256(input.source),
        created_by: actorRef(actor),
        approval_status: approve ? "approved" : "pending_approval",
        approved_by: approve ? actorRef(actor) : null,
        approved_at: approve ? t : null,
        created_at: t,
      })
      .execute();
    await trx
      .updateTable("templates")
      .set({
        current_version: version,
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      })
      .where("id", "=", templateId)
      .execute();
  });
  const t2 = await getTemplate(ctx, templateId);
  await recordAudit(ctx.db, actor, "template.version_created", { name: t2.name, version: created });
  if (approve) await recordAudit(ctx.db, actor, "template.approved", { name: t2.name, version: created });
  return t2;
}

/**
 * Approve a template version. Only a logged-in human can do this, and only through the web UI.
 * There is deliberately no REST or MCP route that calls this function.
 */
export async function approveTemplateVersion(ctx: Ctx, actor: Actor, templateId: string, version: number): Promise<TemplateView> {
  if (actor.kind !== "user") throw new SignedError("PERMISSION_DENIED", "Templates can only be approved by a person in the web UI");
  requirePermission(actor, "templates.approve");
  const res = await ctx.db
    .updateTable("template_versions")
    .set({ approval_status: templateVersionMachine.next("pending_approval", "approve"), approved_by: actorRef(actor), approved_at: now() })
    .where("template_id", "=", templateId)
    .where("version", "=", version)
    .where("approval_status", "in", templateVersionMachine.sources("approve"))
    .executeTakeFirst();
  if (Number(res.numUpdatedRows) > 0) {
    await recordAudit(ctx.db, actor, "template.approved", { name: (await getTemplate(ctx, templateId)).name, version });
  } else {
    const exists = await ctx.db.selectFrom("template_versions").select("id").where("template_id", "=", templateId).where("version", "=", version).executeTakeFirst();
    if (!exists) throw new SignedError("TEMPLATE_NOT_FOUND", `Template ${templateId} has no version ${version}`);
  }
  return getTemplate(ctx, templateId);
}

export async function setTemplateArchived(ctx: Ctx, actor: Actor, templateId: string, archived: boolean): Promise<TemplateView> {
  requirePermission(actor, "templates.manage");
  await getTemplate(ctx, templateId); // TEMPLATE_NOT_FOUND when missing
  // Only a real change is written and logged: archiving twice keeps the first date and one audit entry.
  const res = await ctx.db
    .updateTable("templates")
    .set({ archived_at: archived ? now() : null })
    .where("id", "=", templateId)
    .where("archived_at", archived ? "is" : "is not", null)
    .executeTakeFirst();
  const t = await getTemplate(ctx, templateId);
  if (Number(res.numUpdatedRows) === 0) return t;
  await recordAudit(ctx.db, actor, archived ? "template.archived" : "template.unarchived", { name: t.name });
  return t;
}

export async function getTemplate(ctx: Ctx, templateId: string): Promise<TemplateView> {
  const tpl = await ctx.db.selectFrom("templates").selectAll().where("id", "=", templateId).executeTakeFirst();
  if (!tpl) throw new SignedError("TEMPLATE_NOT_FOUND", `Template ${templateId} does not exist`);
  const versions = await ctx.db
    .selectFrom("template_versions")
    .select(["version", "approval_status", "created_by", "created_at", "approved_by", "approved_at", "content_hash"])
    .where("template_id", "=", templateId)
    .orderBy("version", "desc")
    .execute();
  const approved = versions.find((v) => v.approval_status === "approved");
  return {
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    created_via: tpl.created_via,
    current_version: Number(tpl.current_version),
    approved_version: approved ? Number(approved.version) : null,
    archived: tpl.archived_at !== null,
    folder: tpl.folder_id ? { id: tpl.folder_id, name: (await folderNames(ctx, [tpl.folder_id])).get(tpl.folder_id) ?? "" } : null,
    created_at: tpl.created_at,
    versions: versions.map((v) => ({ ...v, version: Number(v.version) })),
  };
}

/** File a template in a folder, or take it out (null). Owners and administrators only. */
export async function moveTemplate(ctx: Ctx, actor: Actor, templateId: string, folderId: string | null): Promise<TemplateView> {
  requirePermission(actor, "templates.manage");
  await getTemplate(ctx, templateId);
  await ctx.db.updateTable("templates").set({ folder_id: await folderFor(ctx, "template", folderId) }).where("id", "=", templateId).execute();
  return getTemplate(ctx, templateId);
}

/** `folder`: a folder id, or "none" for templates in no folder. */
export async function listTemplates(ctx: Ctx, opts: { archived?: boolean; folder?: string } = {}): Promise<TemplateView[]> {
  let q = ctx.db.selectFrom("templates").select("id").orderBy("created_at", "desc");
  q = opts.archived ? q.where("archived_at", "is not", null) : q.where("archived_at", "is", null);
  if (opts.folder === "none") q = q.where("folder_id", "is", null);
  else if (opts.folder) q = q.where("folder_id", "=", opts.folder);
  const rows = await q.execute();
  return Promise.all(rows.map((r) => getTemplate(ctx, r.id)));
}

export async function getTemplateVersion(ctx: Ctx, templateId: string, version?: number): Promise<TemplateVersionDetail> {
  let q = ctx.db.selectFrom("template_versions").selectAll().where("template_id", "=", templateId);
  q = version === undefined ? q.orderBy("version", "desc").limit(1) : q.where("version", "=", version);
  const v = await q.executeTakeFirst();
  if (!v) {
    throw new SignedError("TEMPLATE_NOT_FOUND", version === undefined ? `Template ${templateId} does not exist` : `Template ${templateId} has no version ${version}`);
  }
  return {
    template_id: templateId,
    version: Number(v.version),
    approval_status: v.approval_status,
    created_by: v.created_by,
    created_at: v.created_at,
    approved_by: v.approved_by,
    approved_at: v.approved_at,
    content_hash: v.content_hash,
    source: v.source,
    fields: JSON.parse(v.field_schema) as FieldDef[],
  };
}

/** Resolve the version a new document should use: the requested one, or the latest approved one. */
export async function resolveVersionForDocument(
  ctx: Ctx,
  templateId: string,
  version?: number,
): Promise<{ id: string; version: number; source: string; template: TemplateView }> {
  const template = await getTemplate(ctx, templateId);
  if (template.archived) throw new SignedError("TEMPLATE_NOT_FOUND", `Template ${templateId} is archived`);
  const target = version ?? template.approved_version;
  if (target === null) {
    throw new SignedError("TEMPLATE_NOT_APPROVED", `Template ${templateId} has no approved version yet. A person must approve it in the Signed.md web UI.`);
  }
  const row = await ctx.db
    .selectFrom("template_versions")
    .select(["id", "version", "source", "approval_status"])
    .where("template_id", "=", templateId)
    .where("version", "=", target)
    .executeTakeFirst();
  if (!row) throw new SignedError("TEMPLATE_NOT_FOUND", `Template ${templateId} has no version ${target}`);
  if (row.approval_status !== "approved") {
    throw new SignedError("TEMPLATE_NOT_APPROVED", `Version ${target} of template ${templateId} is waiting for approval in the Signed.md web UI.`);
  }
  return { id: row.id, version: Number(row.version), source: row.source, template };
}

function accountIdOf(actor: Actor): string {
  if (actor.kind === "user" || actor.kind === "apikey") return actor.accountId;
  throw new SignedError("PERMISSION_DENIED", "Not allowed");
}
