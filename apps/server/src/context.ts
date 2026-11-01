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
export type Actor =
  | { kind: "user"; id: string; accountId: string; label: string }
  | { kind: "apikey"; id: string; accountId: string; label: string; via: "api" | "mcp" }
  | { kind: "signer"; id: string; label: string }
  | { kind: "system"; id: "system"; label: string };

export function actorRef(a: Actor): string {
  return `${a.kind}:${a.id}`;
}

export function actorVia(a: Actor): "ui" | "api" | "mcp" {
  return a.kind === "apikey" ? a.via : "ui";
}
