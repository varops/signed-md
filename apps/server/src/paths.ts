import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The server's folder (apps/server) and the repository root. Found from this file, which is in src/
 * when run from source and in bundle/ in the Docker image: both one level below apps/server. Use
 * these instead of import.meta.url in other files, whose place changes when they are bundled.
 */
export const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ROOT_DIR = join(SERVER_DIR, "..", "..");
export const ASSETS_DIR = join(SERVER_DIR, "assets");
