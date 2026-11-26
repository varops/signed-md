import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT_DIR } from "./paths.ts";

/** The product version: the root package.json, which every package and the Docker image share. */
export const VERSION: string = (JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8")) as { version: string }).version;
