// Reading stored content back, which only `--verify` and a refill after a failed link do.
// Loaded on first use, so an install that trusts the store never parses it.
import { builtin } from "./builtin.ts";
import type { FileEntry } from "./store.ts";

/** Where content is and what it would be called: the store's own spelling of both. */
export interface Names {
  blobPath(file: FileEntry): string;
  contentPath(hash: string, exec: boolean): string;
}

let block: Uint8Array | undefined;

/** A file's sha512, a block at a time: a native binary can be a hundred MB. */
function hashFile(path: string): string {
  const { crypto, fs } = builtin;
  const hash = crypto.createHash("sha512");
  const fd = fs.openSync(path, "r");
  try {
    block ??= new Uint8Array(1024 * 1024);
    for (let n; (n = fs.readSync(fd, block)) > 0;) hash.update(block.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return `sha512-${hash.digest("base64")}`;
}

/** Whether `path` holds the content `file` names. */
function holds(names: Names, file: FileEntry, path: string): boolean {
  return names.contentPath(hashFile(path), file.blob.endsWith("-exec")) === names.blobPath(file);
}

/**
 * Every blob the index names at the right size, and hashed against its own name when written
 * since the index at `at` — or always, under `rehash`. Content is written before its index, so
 * a later mtime is an edit through some project's hardlink or a store restored over this one.
 * It is also a blob a later tarball shares, which the writer touches: so a passing index takes
 * the newest time it hashed, and the next check believes the times again. Not the clock's: an
 * edit landing after its blob was hashed must still be newer than the index.
 */
export function sound(names: Names, files: FileEntry[], at: string, rehash?: boolean): boolean {
  const { fs } = builtin;
  try {
    const since = fs.statSync(at).mtimeMs;
    let newest = since;
    for (const file of files) {
      const path = names.blobPath(file);
      const info = fs.statSync(path, { throwIfNoEntry: false });
      if (info?.size !== file.size) return false;
      const moved = info.mtimeMs > since;
      if (moved) newest = Math.max(newest, info.mtimeMs);
      else if (!rehash) continue;
      if (!holds(names, file, path)) return false;
    }
    try {
      // Rounded up: a date holds whole milliseconds, and one below the blob's would move it again.
      if (newest > since) fs.utimesSync(at, new Date(), new Date(Math.ceil(newest)));
    } catch {} // a store this process cannot write is still whole
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether an entry's files hold their content. One that is still its blob's inode is what the
 * verifying fill hashed; a copy, or a file renamed over its link, is read. Synchronous: the
 * threadpool hop around each stat cost more than the stat.
 */
export function placed(names: Names, files: FileEntry[], pkgDir: string): boolean {
  const { fs, path } = builtin;
  const later = foldsOf(files);
  try {
    for (const file of files) {
      const at = path.join(pkgDir, file.path);
      const mine = fs.statSync(at);
      const its = fs.statSync(names.blobPath(file), { throwIfNoEntry: false });
      if (mine.ino === its?.ino && mine.dev === its.dev) continue;
      if (shadowed(later, file, pkgDir, mine)) continue;
      if (!holds(names, file, at)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Every file at its index size, but for one a later file's name hides, as in `placed`. */
export function sized(files: FileEntry[], pkgDir: string): boolean {
  const { fs, path } = builtin;
  const later = foldsOf(files);
  try {
    for (const file of files) {
      const mine = fs.statSync(path.join(pkgDir, file.path), { throwIfNoEntry: false });
      if (mine?.size !== file.size && !(mine && shadowed(later, file, pkgDir, mine))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Folded name -> the last file under it, for names two or more files share. A case-insensitive
 * disk keeps one file for `A.js` and `a.js`, and the linker makes it the later one's. A fold
 * wider than the disk's only asks it more: `shadowed` lets the disk decide.
 */
function foldsOf(files: FileEntry[]): Map<string, FileEntry> {
  const seen = new Set<string>();
  const last = new Map<string, FileEntry>();
  for (const file of files) {
    const key = fold(file.path);
    if (seen.has(key)) last.set(key, file);
    else seen.add(key);
  }
  return last;
}

function fold(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase();
}

/** Whether `file`'s name, stat'd as `mine`, opens the file of the later one it folds to. */
function shadowed(
  later: Map<string, FileEntry>,
  file: FileEntry,
  pkgDir: string,
  mine: { ino: number; dev: number },
): boolean {
  const winner = later.size > 0 ? later.get(fold(file.path)) : undefined;
  if (!winner || winner === file) return false;
  const { fs, path } = builtin;
  const its = fs.statSync(path.join(pkgDir, winner.path), { throwIfNoEntry: false });
  return mine.ino === its?.ino && mine.dev === its.dev;
}
