import { readFileSync } from "node:fs";

/** The product version: the root package.json, which every package and the Docker image share. */
export const VERSION: string = (JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string }).version;
