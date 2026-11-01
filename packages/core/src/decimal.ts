/** Minimal exact decimal helpers. Money and limits never go through floats. */

const DECIMAL = /^-?\d+(\.\d+)?$/;

export function isDecimalString(s: string): boolean {
  return DECIMAL.test(s);
}

/** Convert a JS number or decimal string to a canonical decimal string, or null if invalid. */
export function toDecimalString(input: unknown): string | null {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return null;
    if (Number.isInteger(input)) return Number.isSafeInteger(input) ? String(input) : null;
    const s = String(input);
    return s.includes("e") ? null : s;
  }
  if (typeof input === "string") {
    const t = input.trim();
    if (!DECIMAL.test(t)) return null;
    return canonical(t);
  }
  return null;
}

function canonical(s: string): string {
  let neg = s.startsWith("-");
  let [int, frac = ""] = (neg ? s.slice(1) : s).split(".") as [string, string?];
  int = int.replace(/^0+(?=\d)/, "");
  frac = frac.replace(/0+$/, "");
  if (int === "0" && frac === "") neg = false;
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

export function fractionDigits(s: string): number {
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
}

/** Scale a canonical decimal string to a BigInt with the given number of fraction digits. */
function scaled(s: string, digits: number): bigint {
  const neg = s.startsWith("-");
  const [int, frac = ""] = (neg ? s.slice(1) : s).split(".") as [string, string?];
  const v = BigInt(int + frac.padEnd(digits, "0"));
  return neg ? -v : v;
}

export function compareDecimal(a: string, b: string): number {
  const d = Math.max(fractionDigits(a), fractionDigits(b));
  const x = scaled(a, d);
  const y = scaled(b, d);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Pad a canonical decimal to exactly `digits` fraction digits. Caller ensures it has no more. */
export function padFraction(s: string, digits: number): string {
  if (digits === 0) return s;
  const [int, frac = ""] = s.split(".") as [string, string?];
  return `${int}.${frac.padEnd(digits, "0")}`;
}
