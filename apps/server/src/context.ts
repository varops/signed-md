import type { Database, Dialect } from "@signed-md/db";
import type { Kysely } from "kysely";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import type { Mailer } from "./services/mail.ts";
import type { Storage } from "./storage.ts";

/** Everything a service needs. Created once at startup and passed explicitly. */
export interface Ctx {
  config: Config;
  db: Kysely<Database>;
  dialect: Dialect;
  keys: Keys;
  storage: Storage;
  mailer: Mailer;
}

/** Who is acting. Recorded on every event. */
export type Role = "owner" | "admin" | "member" | "viewer";

export type Actor =
  /** A person logged in to the web UI. `label` is their email. */
  | { kind: "user"; id: string; accountId: string; label: string; name: string; role: Role }
  /** An API key. It acts as the user who owns it, with that user's role. */
  | { kind: "apikey"; id: string; accountId: string; label: string; via: "api" | "mcp"; userId: string; userName: string; role: Role }
  | { kind: "signer"; id: string; label: string }
  /** Internal work (worker, CLI, demo). Not reachable from any interface. */
  | { kind: "system"; id: "system"; label: string };

export const SYSTEM: Actor = { kind: "system", id: "system", label: "Signed.md" };

export function actorRef(a: Actor): string {
  return `${a.kind}:${a.id}`;
}

export function actorVia(a: Actor): "ui" | "api" | "mcp" {
  return a.kind === "apikey" ? a.via : "ui";
}
