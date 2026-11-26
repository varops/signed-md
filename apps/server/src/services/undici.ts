// undici for webhook deliveries and timestamp requests, loaded with import("./undici.ts") on first use
// so it stays out of start-up. Import it through this file, not import("undici") directly: in the
// bundle (scripts/bundle.mjs), a dynamic import of a CommonJS package only has a default export.
export { Agent, fetch } from "undici";
