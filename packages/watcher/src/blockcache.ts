import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BlockCache } from "@watchtower/collectors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Block slices shared through a folder, so several watchers on one machine download each NEAR
 * block once. The first watcher to need a slice takes a short lock and fetches it; the others
 * wait for its file. Files are small (only receipts that logged something) and pruned after a while.
 */
export class FileBlockCache implements BlockCache {
  constructor(readonly dir: string, readonly keepMs = 10 * 60_000) {
    mkdirSync(dir, { recursive: true });
  }

  private read<T>(file: string): { hit: true; value: T } | { hit: false } {
    try {
      return { hit: true, value: JSON.parse(readFileSync(file, "utf8")) as T };
    } catch {
      return { hit: false };
    }
  }

  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const file = join(this.dir, `${key}.json`);
    const lock = `${file}.lock`;
    let cached = this.read<T>(file);
    if (cached.hit) return cached.value;
    let mine = false;
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      mine = true;
    } catch {
      // Another watcher is fetching it: wait for its file, unless the lock is stale.
      for (let i = 0; i < 60 && existsSync(lock); i++) {
        await sleep(250);
        cached = this.read<T>(file);
        if (cached.hit) return cached.value;
        try {
          if (Date.now() - statSync(lock).mtimeMs > 30_000) unlinkSync(lock);
        } catch {
          /* gone already */
        }
      }
      cached = this.read<T>(file);
      if (cached.hit) return cached.value;
    }
    try {
      const value = await load();
      if (value !== null && value !== undefined) {
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, file);
      }
      return value;
    } finally {
      if (mine) {
        try {
          unlinkSync(lock);
        } catch {
          /* already removed */
        }
      }
    }
  }

  /** Delete slices older than keepMs. */
  prune(): void {
    const cutoff = Date.now() - this.keepMs;
    for (const f of readdirSync(this.dir)) {
      try {
        if (statSync(join(this.dir, f)).mtimeMs < cutoff) unlinkSync(join(this.dir, f));
      } catch {
        /* another watcher pruned it */
      }
    }
  }
}
