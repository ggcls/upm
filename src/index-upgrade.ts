// An index from before it kept a package's aliases, written again with them once `declaredIn`
// has read them, so the next link need not read the package.json. Loaded only once one is found.
import { builtin } from "./builtin.ts";
import type { PackageIndex } from "./store.ts";

/**
 * Write `index` over the one at `at`. Renamed in whole, so a reader sees one index or the other,
 * and both are right. It keeps the old index's mtime: `sound` in verify.ts hashes every blob
 * newer than its index, and a fresh time would hide an edit made since. A store this process
 * cannot write keeps the old one. Synchronous: through the threadpool, after the link, `nuxt`'s
 * 558 cost its install over 100 ms.
 */
export function keepAliases(at: string, index: PackageIndex): void {
  const { fs } = builtin;
  const temp = `${at}.${globalThis.process?.pid}-${globalThis.crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    const { atime, mtimeMs } = fs.statSync(at);
    fs.writeFileSync(temp, JSON.stringify(index), { mode: 0o644, flag: "wx" });
    // Down to the millisecond, never up as `mtime`'s Date rounds: a later time would hide a
    // blob edited just after the index.
    fs.utimesSync(temp, atime, Math.floor(mtimeMs) / 1000);
    fs.renameSync(temp, at);
  } catch {
    try {
      fs.unlinkSync(temp);
    } catch {}
  }
}
