/**
 * Minimal DER (ASN.1) encoder and decoder. Enough for CMS signatures, RFC 3161 timestamps,
 * and reading X.509 structures, with no dependencies, so the offline verifier stays small.
 */

export interface DerNode {
  /** Full identifier octet (class, constructed bit, tag number). */
  tag: number;
  constructed: boolean;
  /** Offset of the identifier octet in the source buffer. */
  start: number;
  /** Offset where the content starts. */
  contentStart: number;
  /** Offset just past the end of this element. */
  end: number;
  /** The whole element, header included. */
  raw: Uint8Array;
  /** Content octets. */
  value: Uint8Array;
  children: DerNode[];
}

export function derDecode(buf: Uint8Array, offset = 0): DerNode {
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("High tag numbers are not supported");
  let pos = offset + 1;
  let len = buf[pos++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("Unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++]!;
  }
  const contentStart = pos;
  const end = contentStart + len;
  if (end > buf.length) throw new Error("DER element runs past the end of the buffer");
  const constructed = (tag & 0x20) !== 0;
  const node: DerNode = {
    tag,
    constructed,
    start: offset,
    contentStart,
    end,
    raw: buf.subarray(offset, end),
    value: buf.subarray(contentStart, end),
    children: [],
  };
  if (constructed) {
    let p = contentStart;
    while (p < end) {
      const child = derDecode(buf, p);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

/** Decode the content of a primitive OCTET STRING etc. as a nested DER element. */
export function derDecodeValue(node: DerNode): DerNode {
  return derDecode(node.value, 0);
}

export function oidToString(value: Uint8Array): string {
  const parts: number[] = [];
  let v = 0;
  for (let i = 0; i < value.length; i++) {
    v = v * 128 + (value[i]! & 0x7f);
    if (!(value[i]! & 0x80)) {
      if (parts.length === 0) {
        const first = v < 80 ? Math.floor(v / 40) : 2;
        parts.push(first, v - first * 40);
      } else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

export function derTime(node: DerNode): Date {
  const s = new TextDecoder().decode(node.value);
  if (node.tag === 0x17) {
    // UTCTime YYMMDDHHMMSSZ
    const y = Number(s.slice(0, 2));
    return new Date(Date.UTC(y < 50 ? 2000 + y : 1900 + y, Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12))));
  }
  // GeneralizedTime YYYYMMDDHHMMSS[.fff]Z
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new Error(`Unsupported time '${s}'`);
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms));
}

// ---- Encoding ----

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function encodeLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), encodeLength(content.length), content]);
}

export const der = {
  seq: (...items: Uint8Array[]) => tlv(0x30, concat(items)),
  /** SET OF, sorted by encoding as DER requires. */
  set: (...items: Uint8Array[]) =>
    tlv(
      0x31,
      concat(
        [...items].sort((a, b) => {
          for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
          return a.length - b.length;
        }),
      ),
    ),
  oid(s: string): Uint8Array {
    const nums = s.split(".").map(Number);
    const out: number[] = [nums[0]! * 40 + nums[1]!];
    for (const n of nums.slice(2)) {
      const chunk: number[] = [n & 0x7f];
      let v = Math.floor(n / 128);
      while (v > 0) {
        chunk.unshift((v & 0x7f) | 0x80);
        v = Math.floor(v / 128);
      }
      out.push(...chunk);
    }
    return tlv(0x06, Uint8Array.from(out));
  },
  /** INTEGER from a non-negative bigint or big-endian unsigned bytes. */
  int(v: bigint | number | Uint8Array): Uint8Array {
    let bytes: Uint8Array;
    if (v instanceof Uint8Array) bytes = v;
    else {
      let n = BigInt(v);
      const arr: number[] = [];
      do {
        arr.unshift(Number(n & 0xffn));
        n >>= 8n;
      } while (n > 0n);
      bytes = Uint8Array.from(arr);
    }
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0 && !(bytes[i + 1]! & 0x80)) i++;
    bytes = bytes.subarray(i);
    if (bytes[0]! & 0x80) bytes = concat([Uint8Array.of(0), bytes]);
    return tlv(0x02, bytes);
  },
  octet: (b: Uint8Array) => tlv(0x04, b),
  null: () => Uint8Array.of(0x05, 0x00),
  bool: (b: boolean) => Uint8Array.of(0x01, 0x01, b ? 0xff : 0x00),
  utf8: (s: string) => tlv(0x0c, new TextEncoder().encode(s)),
  generalizedTime(d: Date): Uint8Array {
    const p = (n: number, w = 2) => String(n).padStart(w, "0");
    const s = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    return tlv(0x18, new TextEncoder().encode(s));
  },
  /** Context-specific tag [n]. Constructed for EXPLICIT tagging or IMPLICIT constructed types. */
  ctx: (n: number, content: Uint8Array, constructed = true) => tlv(0x80 | (constructed ? 0x20 : 0) | n, content),
  raw: (b: Uint8Array) => b,
  concat,
};
