import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

/**
 * Local filesystem artifact storage. Writes are atomic (temp file + rename).
 * There is deliberately no delete operation.
 */
export class Storage {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  private resolve(path: string): string {
    const full = normalize(join(this.root, path));
    if (!full.startsWith(this.root + sep)) throw new Error(`Invalid storage path '${path}'`);
    return full;
  }

  async write(path: string, data: Uint8Array | string): Promise<void> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, data);
    await rename(tmp, full);
  }

  async read(path: string): Promise<Buffer> {
    return readFile(this.resolve(path));
  }
}
