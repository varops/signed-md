import { readFileSync } from "node:fs";
import { trustedKeysFrom, verifyPackage } from "./index.ts";

const HELP = `signed-md verify <agreement.zip> [--keys <keys.json>] [--json]

Verifies a Signed.md completion package offline:
  - every file matches the signed manifest
  - the manifest signature is valid
  - the evidence log hash chain is intact
  - every signer signed the exact agreement content

--keys  A keys file you trust (download /.well-known/signed-md-keys.json from the
        sender's server once and keep it). Without it, the package is checked against
        the public key it carries, which proves integrity but not who signed it.
--json  Print the full report as JSON.`;

export function run(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd !== "verify" || rest.includes("-h") || rest.includes("--help")) {
    console.log(HELP);
    return cmd === "verify" || cmd === "-h" || cmd === "--help" || cmd === undefined ? 0 : 2;
  }
  const file = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--keys");
  if (!file) {
    console.error("Missing package file.\n\n" + HELP);
    return 2;
  }
  const keysIdx = rest.indexOf("--keys");
  const keysFile = keysIdx >= 0 ? rest[keysIdx + 1] : undefined;
  if (keysIdx >= 0 && (!keysFile || keysFile.startsWith("--"))) {
    console.error("--keys needs a keys file.\n\n" + HELP);
    return 2;
  }
  let trustedKeys: ReturnType<typeof trustedKeysFrom> | undefined;
  let bytes: Uint8Array;
  try {
    trustedKeys = keysFile ? trustedKeysFrom(readFileSync(keysFile, "utf8")) : undefined;
  } catch (e) {
    console.error(`Could not read the keys file ${keysFile}: ${reason(e)}`);
    return 2;
  }
  try {
    bytes = new Uint8Array(readFileSync(file));
  } catch (e) {
    console.error(`Could not read ${file}: ${reason(e)}`);
    return 2;
  }
  let report: ReturnType<typeof verifyPackage>;
  try {
    report = verifyPackage(bytes, trustedKeys ? { trustedKeys } : {});
  } catch (e) {
    console.error(`INVALID: ${file} is not a Signed.md package (${reason(e)}).`);
    return 1;
  }

  if (rest.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  console.log(`${report.title ?? "Unknown document"} (${report.document_id ?? "?"})`);
  console.log(`Revision ${report.revision ?? "?"} · key ${report.key_id ?? "?"}\n`);
  for (const c of report.checks) console.log(`  ${mark(c.ok)} ${c.name}${c.detail ? `  – ${c.detail}` : ""}`);
  console.log("");
  if (report.ok) {
    console.log(trustedKeys ? "VALID: the package is intact and signed by a key you trust." : "VALID: the package is intact. Pass --keys to also check who signed it.");
  } else {
    console.log("INVALID: the package was changed or is incomplete.");
  }
  return report.ok ? 0 : 1;
}

/** A short reason for an error, without the stack trace. */
function reason(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return "no such file";
  if (e && typeof e === "object" && "code" in e && e.code === "EISDIR") return "it is a folder";
  return e instanceof Error ? e.message : String(e);
}
