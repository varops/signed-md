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
  const trustedKeys = keysIdx >= 0 ? trustedKeysFrom(readFileSync(rest[keysIdx + 1]!, "utf8")) : undefined;
  const report = verifyPackage(new Uint8Array(readFileSync(file)), trustedKeys ? { trustedKeys } : {});

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
