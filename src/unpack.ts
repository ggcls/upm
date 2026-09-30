// The writing half of the store: where content lives, how it is put there, and how a verified
// tarball becomes content plus an index. Nothing here touches the network or any shared memo,
// so a worker thread can run it against the same store directory as the main thread.
import { builtin } from "./builtin.ts";
import { normalizeBin } from "./normalize-bin.ts";
import { createVerifier, hashOf, parseIntegrity } from "./integrity.ts";
import type { FileEntry, PackageIndex } from "./store.ts";
import { extractTar } from "./tar.ts";
import { createLimiter } from "./limit.ts";
import { pid } from "./runtime.ts";
import { sizeOfSync } from "./util.ts";
import { now, tick, tracing } from "./util.ts";

// Content is hardlinked into every project sharing this store, so a write through any of
// those links would corrupt all of them. Read-only makes that fail instead of spread.
const FILE_MODE = 0o444;
const EXEC_MODE = 0o555;

/**
 * Files in flight per writer. A package's files are independent, and awaiting them one at a
 * time leaves the disk idle for a thread hop per file — 8,527 of them for `next` alone.
 */
const WRITES = 16;

/**
 * Where a tarball is parsed into parts: its files packed into buffers as they are parsed, one
 * part per PART_BYTES of files, each part one thread's work, and its big files spooled as they
 * inflate. Under this a tarball is one thread's job, whole, its hashes taken while it inflates;
 * `next` (40 MiB compressed, 182 MiB of files) spent ~520 ms hashing and writing serially after
 * a ~310 ms inflate. A part under PART_MIN is not worth its message and joins another.
 */
export const SHARD_MIN = 4 * 1024 * 1024;
const PART_BYTES = 16 * 1024 * 1024;
const PART_MIN = 1024 * 1024;
/** What a file costs to hash and write besides its bytes, in bytes: `next` measured ~30 KB. */
const FILE_COST = 32 * 1024;
/** A part's files are packed into buffers this big; a file bigger than one gets its own. */
const CHUNK = 4 * 1024 * 1024;

/** One thread's share of a big tarball: its files, packed into buffers that can be handed over. */
export interface Part {
  data: ArrayBuffer[];
  files: PartFile[];
  /** What the tarball's package.json says it is: on the first part only, for `assemble`. */
  name?: string;
  version?: string;
}

export interface PartFile {
  path: string;
  exec: boolean;
  /** Where in `data` the file is: which buffer, and the offset into it. */
  chunk: number;
  at: number;
  size: number;
  /**
   * A big file already on disk under this temp name, hashed and written as it inflated. Its
   * blob is known; `writePart` only moves it into place, once the tarball has verified.
   */
  temp?: string;
  blob?: string;
}

interface Bin {
  data: ArrayBuffer[];
  files: BinFile[];
  /** Bytes plus a FILE_COST per file: what the part will take to write. */
  weight: number;
  /** Unused tail of the last buffer. */
  room: number;
}

type BinFile = PartFile & { mode: number; hash?: string };

/** A file big enough to hash and write while the rest of the tarball still inflates. */
const STREAM_FILE = CHUNK;

export interface Writer {
  contentPath(hash: string, exec: boolean): string;
  /** Absolute path of a `FileEntry.blob`. */
  blobPath(blob: string): string;
  indexPath(integrity: string): string;
  ensureDir(path: string): Promise<void>;
  put(file: string, data: Uint8Array, mode: number, force?: boolean): Promise<void>;
  /** Write every file of a verified tarball and describe what was written. */
  unpack(integrity: string, tarball: Uint8Array[], repair: boolean): Promise<PackageIndex>;
  /**
   * Parse a tarball into at most `most` parts for as many threads. The parts' blobs, joined by
   * `assemble`, are its index. Nothing is written: the caller checks the hash first.
   */
  split(source: AsyncIterable<Uint8Array>, most: number): Promise<Part[]>;
  /** Hash and write one part's files; the blob of each, in the part's order. */
  writePart(part: Part, repair: boolean): Promise<string[]>;
  /** Remove what `split` left on disk for parts that will not be written: the tarball failed. */
  discard(parts: Part[]): void;
}

export interface WriterOptions {
  /**
   * May write a small tarball's files with the blocking calls instead of the threadpool.
   * Right for a worker thread, which has nothing else to do while a write lands: a few files
   * are a few syscalls, and the hop to the threadpool and back costs more than each one. A
   * big tarball still writes through the threadpool, four writes at a time under its hashing.
   * Wrong for the main thread, which has a network to drive.
   */
  blocking?: boolean;
}

export function createWriter(dir: string, options: WriterOptions = {}): Writer {
  // Read once per writer: `contentPath` runs per file per install, 10,174 times for `next`.
  const { dirname, join, sep } = builtin.path;
  const pooled: Io = builtin.fsp;
  const direct: Io = options.blocking ? blocking() : pooled;
  const files = join(dir, "files");
  const indexes = join(dir, "index");
  // mkdir dominates once files are links, so never ask twice for the same directory.
  const made = new Map<string, Promise<void>>();
  const write = createLimiter(WRITES);

  function ensureDir(path: string, io: Io = pooled): Promise<void> {
    let making = made.get(path);
    if (!making) {
      making = io.mkdir(path, { recursive: true }).then(
        () => undefined,
        (error: unknown) => {
          made.delete(path);
          throw wrapped(error, `create ${path}`);
        },
      );
      made.set(path, making);
    }
    return making;
  }

  // Concatenated, not joined: `files` is already absolute and normalized, and a blob is
  // base64url with `sep` between shard and name, so there is nothing for join's normalize pass
  // to do. It runs once per file per install — 10,174 times for `next` — and was a tenth of a
  // warm install on its own.
  function blobPath(blob: string): string {
    return `${files}${sep}${blob}`;
  }

  // Spelled with this platform's `sep`, so the string the linker concatenates is the one the
  // collector's `path.join` walk lists — a `/` on Windows would miss and prune every live blob.
  function blobOf(hash: string, exec: boolean): string {
    const { shard, name } = shardOf(hash);
    return `${shard}${sep}${exec ? `${name}-exec` : name}`;
  }

  function contentPath(hash: string, exec: boolean): string {
    return blobPath(blobOf(hash, exec));
  }

  function indexPath(integrity: string): string {
    const { shard, name } = shardOf(integrity);
    return `${indexes}${sep}${shard}${sep}${name}.json`;
  }

  async function put(
    file: string,
    data: Uint8Array,
    mode: number,
    force = false,
    io: Io = pooled,
  ): Promise<void> {
    try {
      await writeInto(file, data, mode, force, io);
    } catch (error) {
      // The shard directory went out from under us — a prune compacting what was, for the
      // moment between `ensureDir` and here, an empty shard. `made` still says we created it,
      // so nothing else would ever make it again. Remake it and write once more.
      if ((error as { cause?: string }).cause !== "ENOENT") throw error;
      await io.mkdir(dirname(file), { recursive: true });
      await writeInto(file, data, mode, force, io);
    }
  }

  async function writeInto(
    file: string,
    data: Uint8Array,
    mode: number,
    force: boolean,
    { rename, rm, utimes, writeFile }: Io,
  ): Promise<void> {
    // Content is immutable and named by its own hash, so an exclusive create asks whether we
    // already have it and writes it if not, in one syscall. An index is not immutable, and
    // `force` also covers repairing damaged content: both fall through to the atomic path.
    if (!force) {
      try {
        await writeFile(file, data, { mode, flag: "wx" });
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw wrapped(error, `write ${file}`);
        // The right length means the whole file is there: content of this hash is these bytes.
        // Anything shorter is a write still in flight or one a crash cut off, so replace it.
        if (sizeOfSync(file) === data.length) {
          // Touch it, so a concurrent prune reads "someone still wants this" from the mtime.
          await utimes(file, new Date(), new Date()).catch(() => {});
          return;
        }
      }
    }
    const temp = `${file}.${pid}-${tempToken()}-${tmpSeq++}.tmp`;
    try {
      await writeFile(temp, data, { mode });
      // rename is atomic within a directory, so a concurrent upm never sees a torn file.
      await rename(temp, file);
    } catch (error) {
      // Windows will not rename onto a read-only file, and content is read-only. A whole file
      // there is this content by construction; one cut short, or one `force` is repairing, is
      // replaced once its read-only bit is lifted.
      const code = (error as { code?: string }).code;
      const taken = code === "EEXIST" || code === "EPERM";
      const stale = taken && (force || sizeOfSync(file) !== data.length);
      if (stale && (await replaceReadOnly(temp, file, mode, rename))) return;
      await rm(temp, { force: true });
      // Read again: a concurrent writer may have finished it meanwhile.
      if (!taken || sizeOfSync(file) !== data.length) throw wrapped(error, `write ${file}`);
    }
  }

  /**
   * Rename `temp` over a read-only `file`. A replace onto a writable name is still atomic, so no
   * reader sees the name missing. On failure the bit goes back: shared content stays read-only.
   */
  async function replaceReadOnly(
    temp: string,
    file: string,
    mode: number,
    rename: Io["rename"],
  ): Promise<boolean> {
    try {
      builtin.fs.chmodSync(file, 0o644);
    } catch {
      return false; // gone meanwhile, or not ours to change
    }
    try {
      await rename(temp, file);
      return true;
    } catch {
      try {
        builtin.fs.chmodSync(file, mode);
      } catch {}
      return false;
    }
  }

  async function unpack(
    integrity: string,
    tarball: Uint8Array[],
    repair: boolean,
  ): Promise<PackageIndex> {
    const found = new Map<string, { mode: number; data: Uint8Array; hash: string }>();
    const hashing: Promise<void>[] = [];
    let t = tracing ? now() : 0;
    let bytes = 0;
    // Hash each file as it comes out of the tar: the inflate runs on the threadpool, the
    // digest on this thread, and done together they take the longer of the two rather than
    // the sum — 270 and 260 ms on `next`. Buffer the files themselves: a declared bin must be
    // executable even when the tarball ships it 0666, and package.json can arrive after the
    // file it names. Last entry wins, as tar does.
    for await (const entry of extractTar(each(tarball))) {
      const file = { mode: entry.mode, data: entry.data, hash: "" };
      found.set(entry.path, file);
      bytes += entry.data.length;
      // Not awaited one at a time: off Node each digest is a hop to another thread.
      if (tracing) {
        const h = now();
        hashing.push(hashOf(entry.data).then((hash) => void (file.hash = hash)));
        tick("hash", now() - h);
      } else hashing.push(hashOf(entry.data).then((hash) => void (file.hash = hash)));
    }
    await Promise.all(hashing);
    if (tracing) {
      tick("parse", now() - t);
      tick("bytes", bytes);
      tick("n", found.size);
      t = now();
    }

    // Writes only now, not as the files stream: through the threadpool they would queue
    // ahead of every inflate step and stretch it, which measured slower than this on `next`.
    // One block is a small tarball, and its files go straight to the disk if allowed.
    const io = tarball.length === 1 ? direct : pooled;
    const { bins, name, version } = manifestOf(found.get("package.json")?.data);
    const entries: FileEntry[] = [];
    const written = new Set<string>();
    const jobs: Promise<void>[] = [];
    let unpackedSize = 0;
    for (const [path, { mode, data, hash }] of found) {
      const exec = (mode & 0o111) !== 0 || bins.has(path);
      const blob = blobOf(hash, exec);
      const target = blobPath(blob);
      if (!written.has(target)) {
        written.add(target);
        jobs.push(
          write(async () => {
            await ensureDir(dirname(target), io);
            await put(target, data, exec ? EXEC_MODE : FILE_MODE, repair, io);
          }),
        );
      }
      entries.push({ path, blob, size: data.length });
      unpackedSize += data.length;
    }
    // Settled, not raced: a write left running past a sibling's failure would report as unhandled.
    for (const job of await Promise.allSettled(jobs)) {
      if (job.status === "rejected") throw job.reason;
    }
    if (tracing) tick("write", now() - t);
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { integrity, files: entries, unpackedSize, name, version };
  }

  async function split(source: AsyncIterable<Uint8Array>, most: number): Promise<Part[]> {
    const bins: Bin[] = Array.from({ length: Math.max(1, most) }, () => ({
      data: [],
      files: [],
      weight: 0,
      room: 0,
    }));
    // Each file to the lightest bin so far, copied as it comes out of the tar: the copy hides
    // under the inflate. Last entry for a path wins, as tar does; its earlier bytes stay
    // packed and unreferenced.
    const latest = new Map<string, { bin: Bin; file: BinFile }>();
    let total = 0;
    let t = tracing ? now() : 0;
    let copying = 0;
    // A big file is hashed and written to a temp name as it inflates, when the thread may
    // block: `next`'s 97 MiB binary was 200 ms of hash, copies and write after its last byte.
    const spool = options.blocking ? createSpool(files) : undefined;
    try {
      await parse();
    } catch (error) {
      spool?.abandon();
      throw error;
    }
    async function parse(): Promise<void> {
      for await (const { path, mode, data, size } of extractTar(source, { stream: spool?.open })) {
        const c = tracing ? now() : 0;
        let bin = bins[0]!;
        for (const other of bins) if (other.weight < bin.weight) bin = other;
        if (spool && data.length !== size) {
          const { hash, temp } = spool.close();
          const file = { path, exec: false, chunk: -1, at: 0, size, mode, temp, hash };
          bin.weight += FILE_COST; // its bytes are on disk already; the part only moves them
          latest.set(path, { bin, file });
          continue;
        }
        if (data.length > CHUNK) {
          bin.data.push(new ArrayBuffer(data.length));
          bin.room = 0;
        } else if (bin.room < data.length || bin.data.length === 0) {
          bin.data.push(new ArrayBuffer(CHUNK));
          bin.room = CHUNK;
        }
        const chunk = bin.data.length - 1;
        const at = bin.data[chunk]!.byteLength - (bin.room || data.length);
        new Uint8Array(bin.data[chunk]!, at, data.length).set(data);
        if (tracing) copying += now() - c;
        bin.room = Math.max(0, bin.room - data.length);
        bin.weight += data.length + FILE_COST;
        total += data.length;
        latest.set(path, { bin, file: { path, exec: false, chunk, at, size: data.length, mode } });
      }
    }
    if (tracing) {
      tick("split", now() - t);
      tick("splitCopy", copying);
      tick("n", latest.size);
      tick("bytes", total);
    }
    for (const { bin, file } of latest.values()) bin.files.push(file);
    const manifest = latest.get("package.json");
    const {
      bins: declared,
      name,
      version,
    } = manifestOf(manifest && packed(manifest.bin, manifest.file));
    // As many parts as the bytes are worth, and none too small to be worth its message: the
    // lightest bins fold into the next lightest until that holds.
    const count = Math.max(1, Math.min(most, Math.ceil(total / PART_BYTES)));
    let parts = bins.filter((bin) => bin.files.length > 0).sort((a, b) => a.weight - b.weight);
    while (parts.length > 1 && (parts.length > count || parts[0]!.weight < PART_MIN)) {
      const [small, into] = parts as [Bin, Bin, ...Bin[]];
      for (const file of small.files)
        into.files.push({ ...file, chunk: file.chunk + into.data.length });
      into.data.push(...small.data);
      into.weight += small.weight;
      parts = parts.slice(1).sort((a, b) => a.weight - b.weight);
    }
    const kept = new Set([...latest.values()].map(({ file }) => file.temp));
    spool?.drop((temp) => kept.has(temp)); // a later entry for the path won, as tar has it
    return parts.map(({ data, files }, i) => ({
      data,
      files: files.map(({ path, chunk, at, size, mode, temp, hash }) => {
        const exec = (mode & 0o111) !== 0 || declared.has(path);
        return { path, exec, chunk, at, size, ...(temp && { temp, blob: blobOf(hash!, exec) }) };
      }),
      ...(i === 0 && { name, version }),
    }));
  }

  async function writePart(part: Part, repair: boolean): Promise<string[]> {
    const blobs: string[] = [];
    const written = new Set<string>();
    for (const file of part.files) {
      const { exec } = file;
      if (file.temp) {
        blobs.push(file.blob!);
        const target = blobPath(file.blob!);
        if (written.has(target)) {
          // The same content twice in one part: the first temp became the blob, this one goes.
          builtin.fs.rmSync(file.temp, { force: true });
          continue;
        }
        written.add(target);
        await ensureDir(dirname(target), direct);
        adopt(file.temp, target, exec ? EXEC_MODE : FILE_MODE, file.size, repair);
        continue;
      }
      const data = packed(part, file);
      let t = tracing ? now() : 0;
      const blob = blobOf(await hashOf(data), exec);
      if (tracing) tick("hash", now() - t);
      blobs.push(blob);
      const target = blobPath(blob);
      if (written.has(target)) continue;
      written.add(target);
      if (tracing) t = now();
      await ensureDir(dirname(target), direct);
      await put(target, data, exec ? EXEC_MODE : FILE_MODE, repair, direct);
      if (tracing) tick("write", now() - t);
    }
    return blobs;
  }

  /**
   * Move a spooled file into place. Content already there at the right size is this content,
   * so the temp goes and the blob is touched, as `writeInto` does; `repair` replaces it.
   */
  function adopt(temp: string, target: string, mode: number, size: number, repair: boolean): void {
    const fs = builtin.fs;
    try {
      if (!repair && sizeOfSync(target) === size) {
        fs.rmSync(temp, { force: true });
        const now = new Date();
        fs.utimesSync(target, now, now);
        return;
      }
      fs.chmodSync(temp, mode);
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw wrapped(error, `write ${target}`);
    }
  }

  function discard(parts: Part[]): void {
    for (const part of parts) {
      for (const file of part.files) {
        if (file.temp) builtin.fs.rmSync(file.temp, { force: true });
      }
    }
  }

  return { contentPath, blobPath, indexPath, ensureDir, put, unpack, split, writePart, discard };
}

interface Spool {
  /** `TarOptions.stream`: takes a file of at least STREAM_FILE bytes. */
  open(path: string, mode: number, size: number): ((chunk: Uint8Array) => void) | undefined;
  /** The file the last `open` took: its hash, and the temp name holding its bytes. */
  close(): { hash: string; temp: string };
  /** Remove the temps `keep` refuses. */
  drop(keep: (temp: string) => boolean): void;
  /** The parse failed: close what is open and remove every temp. */
  abandon(): void;
}

/**
 * Where big files go while their tarball still inflates: hashed chunk by chunk on this thread,
 * under the inflate on the threadpool, and written to a temp name in `files/` — never a blob
 * name, since the tarball is not verified yet. `writePart` renames them in after it is.
 */
function createSpool(files: string): Spool {
  const fs = builtin.fs;
  const temps: string[] = [];
  let current: { fd: number; hash: import("node:crypto").Hash; temp: string } | undefined;
  return {
    open(_path, _mode, size) {
      if (size < STREAM_FILE) return undefined;
      if (temps.length === 0) fs.mkdirSync(files, { recursive: true });
      const temp = `${files}${builtin.path.sep}${pid}-${tempToken()}-${tmpSeq++}.tmp`;
      const fd = fs.openSync(temp, "w", 0o600);
      temps.push(temp);
      current = { fd, hash: builtin.crypto.createHash("sha512"), temp };
      return (chunk) => {
        current!.hash.update(chunk);
        let at = 0;
        while (at < chunk.length) at += fs.writeSync(fd, chunk, at, chunk.length - at);
      };
    },
    close() {
      const { fd, hash, temp } = current!;
      current = undefined;
      fs.closeSync(fd);
      return { hash: `sha512-${hash.digest("base64")}`, temp };
    },
    drop(keep) {
      for (const temp of temps) if (!keep(temp)) fs.rmSync(temp, { force: true });
    },
    abandon() {
      if (current) fs.closeSync(current.fd);
      current = undefined;
      for (const temp of temps) fs.rmSync(temp, { force: true });
    },
  };
}

/** A packed file's bytes. */
function packed({ data }: Part, { chunk, at, size }: PartFile): Uint8Array {
  return new Uint8Array(data[chunk]!, at, size);
}

/** The index of a tarball whose parts were written, from the blobs each part came back with. */
export function assemble(integrity: string, parts: Part[], blobs: string[][]): PackageIndex {
  const entries: FileEntry[] = [];
  let unpackedSize = 0;
  parts.forEach((part, k) => {
    part.files.forEach(({ path, size }, i) => {
      entries.push({ path, blob: blobs[k]![i]!, size });
      unpackedSize += size;
    });
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const { name, version } = parts[0] ?? {};
  return { integrity, files: entries, unpackedSize, name, version };
}

/** The five calls the writer makes, in the shape it makes them. `fs/promises` has them all. */
interface Io {
  mkdir(path: string, options?: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  writeFile(file: string, data: Uint8Array, options: { mode: number; flag?: "wx" }): Promise<void>;
}

/** The same five, blocking, behind the async signatures, so one writer body serves both. */
function blocking(): Io {
  const fs = builtin.fs;
  return {
    mkdir: async (path, options) => fs.mkdirSync(path, options),
    rename: async (from, to) => fs.renameSync(from, to),
    rm: async (path, options) => fs.rmSync(path, options),
    utimes: async (path, atime, mtime) => fs.utimesSync(path, atime, mtime),
    writeFile: async (file, data, options) => fs.writeFileSync(file, data, options),
  };
}

/**
 * Prove the bytes are the tarball the integrity names. Runs on whichever thread unpacks, right
 * before it does: a corrupt tarball must never leave content or an index behind, anywhere.
 */
export async function verifyTarball(integrity: string, tarball: Uint8Array[]): Promise<void> {
  const t = tracing ? now() : 0;
  const verifier = createVerifier(integrity);
  for (const block of tarball) verifier.update(block);
  await verifier.verify();
  if (tracing) tick("verify", now() - t);
}

/**
 * What makes a temp name unique. A pid alone does not: two threads of one process share one,
 * and two containers sharing a store through a bind mount have a pid namespace each. A torn
 * temp file would be renamed over a blob and never rehashed again, so this has to hold. Once
 * per thread, since each has its own module instance.
 */
let token = "";
let tmpSeq = 0;

/** Read on the first temp name, so a run that unpacks nothing never loads crypto. */
function tempToken(): string {
  return (token ||= globalThis.crypto.randomUUID().slice(0, 8));
}

/**
 * What a tarball's package.json says: the paths it declares as bins, which must run whatever
 * mode the tarball used, and the name and version it claims, which the index keeps.
 */
function manifestOf(manifest: Uint8Array | undefined): {
  bins: Set<string>;
  name?: string;
  version?: string;
} {
  if (!manifest) return { bins: new Set() };
  try {
    const json = JSON.parse(new TextDecoder().decode(manifest));
    const bins = new Set(Object.values(normalizeBin(json)));
    return { bins, name: text(json?.name), version: text(json?.version) };
  } catch {
    return { bins: new Set() }; // A package.json we cannot read declares nothing.
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined);

// The final character also has to carry canonical padding bits: 64 bytes is 512 bits but 86
// base64 characters hold 516, and a digest whose 4 slack bits are set decodes and re-encodes to
// a *different* string. Only these final characters leave `parseIntegrity` a no-op.
/** One entry, one supported algorithm, base64 already exactly what `parseIntegrity` would return. */
const CANON =
  /^(?:sha512-[\dA-Za-z+/]{85}[AQgw]==|sha384-[\dA-Za-z+/]{64}|sha256-[\dA-Za-z+/]{42}[AEIMQUYcgkosw048]=|sha1-[\dA-Za-z+/]{26}[AEIMQUYcgkosw048]=)$/;

/** `sha512-a+b/c=` -> shard `ab`, name `sha512-c` — base64url, so both are safe path segments. */
function shardOf(hash: string): { shard: string; name: string } {
  // Every hash the store writes came out of `hashOf` canonical already, so parseIntegrity's
  // base64 round-trip is only worth paying when the string is not yet in the form it would
  // return.
  const at = CANON.test(hash) ? hash.indexOf("-") : -1;
  const { algorithm, digest } =
    at === -1 ? parseIntegrity(hash) : { algorithm: hash.slice(0, at), digest: hash.slice(at + 1) };
  const safe = digest.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return { shard: safe.slice(0, 2), name: `${algorithm}-${safe.slice(2)}` };
}

export function wrapped(error: unknown, what: string): Error {
  const { message, code } = error as { message?: string; code?: string };
  return Object.assign(new Error(`Store failed to ${what}: ${message ?? error}`), {
    code: "ESTORE",
    cause: code,
  });
}

/** A tarball arrives in one or more blocks; gunzip wants them fed in one at a time. */
async function* each(blocks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const block of blocks) yield block;
}
