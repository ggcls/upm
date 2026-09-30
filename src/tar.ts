// Minimal ustar/pax tar reader for npm tarballs: regular files only, hardened paths.
import { builtin } from "./builtin.ts";
import { concat, hasZlib, iterate } from "./runtime.ts";
import { now, tick, tracing } from "./util.ts";

export interface TarEntry {
  /** Path with the leading component stripped, posix separators, never absolute, never containing `..`. */
  path: string;
  /** Normalized permission bits. */
  mode: number;
  /** The file's bytes, or empty when a `TarOptions.stream` consumer took them. */
  data: Uint8Array;
  size: number;
}

export interface TarOptions {
  /**
   * Asked before each file body is read. A consumer takes the file's bytes chunk by chunk as
   * they inflate, and the entry then arrives with empty `data`; undefined buffers the file.
   */
  stream?(path: string, mode: number, size: number): ((chunk: Uint8Array) => void) | undefined;
}

const BLOCK = 512;
/** Ceilings, so a 1 MB tarball cannot declare a 1 GB entry and exhaust memory. */
const MAX_ENTRY = 512 * 1024 * 1024;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
/**
 * A gzip stream hands back this much per step, and each step is a threadpool round trip: the
 * default 16 KB made 11,700 of them for `next`'s 182 MiB. Also the most a tarball may be to
 * inflate in one call instead — under it the stream's setup is most of the cost, over it the
 * one-shot call outgrows its buffer.
 */
const INFLATE_STEP = 1024 * 1024;
/** Inflated bytes that may wait for the parser before the inflate pauses. */
const INFLATE_AHEAD = 4 * INFLATE_STEP;
const EMPTY = new Uint8Array(0);
// process.umask() without an argument is deprecated in some Node builds; fall back to npm's default.
const UMASK = readUmask();

/** Gunzip if needed, then yield the regular files in a npm package tarball. */
export async function* extractTar(
  source: AsyncIterable<Uint8Array>,
  options: TarOptions = {},
): AsyncGenerator<TarEntry> {
  const read = createReader(gunzipped(source));
  let global: Record<string, string> = {};
  let next: Record<string, string> = {};
  let longName = "";

  for (;;) {
    let header = await read(BLOCK);
    if (!header) break;
    if (isZero(header)) {
      // Two zero blocks end the archive; a lone one is padding noise.
      const second = await read(BLOCK);
      if (!second || isZero(second)) break;
      header = second;
    }

    const type = String.fromCodePoint(header[156] ?? 0);
    const meta = "xgLK".includes(type) ? {} : { ...global, ...next };
    // A pax `size` record wins: it is how files past the 8 GB octal field are described.
    const paxSize = Number.parseInt(meta["size"] ?? "", 10);
    const size =
      Number.isInteger(paxSize) && paxSize >= 0 ? paxSize : Math.max(0, num(header, 124, 12));

    if (!checksumOk(header)) {
      await read(padded(size)); // the header is untrusted, but its size is our only way forward
      next = {}; // its pax records die with it, they are not the next entry's
      longName = "";
      continue;
    }
    if (size > MAX_ENTRY) throw fail(`Tar entry ${name(header)} declares ${size} bytes`);
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      const data = await body(read, size);
      if (type === "x" || type === "g") {
        const records = parsePax(data);
        if (type === "g") global = { ...global, ...records };
        else next = { ...next, ...records };
      }
      // `L` carries the next entry's path; `K` a link target, and links are dropped anyway.
      else if (type === "L") longName = text(data).replace(/\0+$/, "");
      continue;
    }

    const raw = meta["path"] || longName || name(header);
    next = {};
    longName = "";

    // Regular files only. `1`/`2` are hard and symbolic links, which npm refuses outright.
    const regular = type === "0" || type === "\0" || type === "7";
    const path = regular ? safePath(raw) : undefined;
    if (!path) {
      await body(read, size); // skipped, but its bytes are still in the way
      continue;
    }
    const mode = normalizeMode(num(header, 100, 8));
    const sink = size > 0 ? options.stream?.(path, mode, size) : undefined;
    const data = sink ? await body(read, size, sink) : await body(read, size);
    yield { path, mode, data, size };
  }
}

/** One entry's bytes, without the block padding after them. */
async function body(read: Reader, size: number, sink?: Sink): Promise<Uint8Array> {
  if (size === 0) return EMPTY;
  const bytes = await read(padded(size), sink && { take: sink, size });
  if (!bytes) throw fail("Unexpected end of tar archive");
  return bytes.subarray(0, size);
}

type Sink = (chunk: Uint8Array) => void;
type Reader = (
  size: number,
  sink?: { take: Sink; size: number },
) => Promise<Uint8Array | undefined>;

/** Buffered exact-size reader. Returns undefined at a clean end, throws on a partial read. */
function createReader(source: AsyncIterable<Uint8Array>): Reader {
  const iterator = source[Symbol.asyncIterator]();
  const pending: Uint8Array[] = [];
  let available = 0;

  return async function read(size, sink) {
    if (size === 0) return EMPTY;
    if (sink) return await drain(size, sink);
    while (available < size) {
      const step = await iterator.next();
      if (step.done) break;
      if (step.value.length > 0) {
        pending.push(step.value);
        available += step.value.length;
      }
    }
    if (available === 0) return undefined;
    if (available < size) throw fail("Unexpected end of tar archive");
    available -= size;
    const first = pending[0]!;
    if (first.length >= size) {
      // Within one chunk: a view, no copy. The common case for a small file.
      if (first.length > size) pending[0] = first.subarray(size);
      else pending.shift();
      return first.subarray(0, size);
    }
    // Spans chunks: copy exactly the bytes asked for, and keep the rest of the last chunk as
    // a view. Copying everything pending here was a MiB per boundary, 33 ms on `next`.
    const merged = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = pending.shift()!;
      const take = Math.min(chunk.length, size - at);
      merged.set(chunk.subarray(0, take), at);
      at += take;
      if (take < chunk.length) pending.unshift(chunk.subarray(take));
    }
    return merged;
  };

  /** Hand `size` bytes to the sink as they come, the first `sink.size` of them, holding none. */
  async function drain(size: number, sink: { take: Sink; size: number }): Promise<Uint8Array> {
    let left = size;
    let wanted = sink.size;
    while (left > 0) {
      if (pending.length === 0) {
        const step = await iterator.next();
        if (step.done) throw fail("Unexpected end of tar archive");
        if (step.value.length === 0) continue;
        pending.push(step.value);
        available += step.value.length;
      }
      const chunk = pending.shift()!;
      const take = Math.min(chunk.length, left);
      if (wanted > 0) sink.take(chunk.subarray(0, Math.min(take, wanted)));
      wanted -= Math.min(take, wanted);
      left -= take;
      available -= take;
      if (take < chunk.length) pending.unshift(chunk.subarray(take));
    }
    return EMPTY;
  }
}

/** npm tarballs are gzipped, but plain tar passes straight through. */
async function* gunzipped(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const head: Uint8Array[] = [];
  let seen = 0;
  while (seen < 2) {
    const step = await iterator.next();
    if (step.done) break;
    head.push(step.value);
    seen += step.value.length;
  }
  const start = seen === 0 ? EMPTY : concat(head, seen);
  // One more step tells whether the whole tarball is already in hand: a source that has run
  // dry here handed over one block, and one block is the size a one-shot inflate is right for.
  const more = seen === 0 ? undefined : await iterator.next();
  async function* rest(): AsyncGenerator<Uint8Array> {
    yield start;
    if (!more || more.done) return;
    yield more.value;
    for (;;) {
      const step = await iterator.next();
      if (step.done) return;
      yield step.value;
    }
  }
  if (start[0] !== 0x1f || start[1] !== 0x8b) {
    yield* rest();
    return;
  }
  try {
    if (more?.done && start.length <= INFLATE_STEP && hasZlib()) {
      const t = tracing ? now() : 0;
      const out = builtin.zlib.gunzipSync(start, { maxOutputLength: MAX_ARCHIVE });
      if (tracing) tick("gunzip", now() - t);
      yield out;
      return;
    }
    if (tracing) tick("streamed", 1);
    // A small tarball can declare gigabytes; refuse rather than fill memory. Counted here:
    // zlib's `maxOutputLength` is for the one-shot call, a stream ignores it.
    let total = 0;
    for await (const chunk of hasZlib() ? inflateNode(rest()) : inflateWeb(rest())) {
      total += chunk.length;
      if (total > MAX_ARCHIVE) throw fail(`Tarball inflates past ${MAX_ARCHIVE} bytes`);
      yield chunk;
    }
  } catch (error) {
    // The source's own errors (network) pass through; a bad stream gets one code and a message.
    const code = (error as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw fail(`Tarball inflates past ${MAX_ARCHIVE} bytes`);
    if (!code || code === "EBADTAR" || !code.startsWith("Z_")) throw error;
    throw fail(`Corrupt gzip: ${code}`);
  }
}

function inflateNode(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const input = builtin.stream.Readable.from(source);
  // Room for the inflate to run ahead on the threadpool while this thread parses. The default
  // 16 KB already overlaps the two more than expected; this is ~10 ms on a 40 MiB tarball, and
  // a bound on what a fast inflate may pile up ahead of a slow parser.
  const gunzip = builtin.zlib.createGunzip({
    chunkSize: INFLATE_STEP,
    readableHighWaterMark: INFLATE_AHEAD,
  } as object);
  input.on("error", (error: Error) => gunzip.destroy(error));
  return input.pipe(gunzip);
}

/** Node has this too, but it costs a few ms to set up where zlib is already there. */
function inflateWeb(source: AsyncIterator<Uint8Array>): AsyncIterable<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const step = await source.next();
      if (step.done) controller.close();
      else controller.enqueue(step.value);
    },
  });
  return iterate(
    stream.pipeThrough(
      new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>,
    ),
  );
}

/** Strip the first component, reject traversal. Returns undefined when the entry must be skipped. */
function safePath(raw: string): string | undefined {
  if (!raw || /^[a-z]:/i.test(raw)) return undefined; // windows drive letter
  const normalized = raw.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return undefined;
  const parts = normalized.split("/");
  if (parts.includes("..")) return undefined;
  const kept = parts.filter((part) => part !== "" && part !== ".");
  // A part like `C:` is a drive, or a stream of another file, on Windows.
  if (raw.includes(":") && kept.some((part, i) => i > 0 && /^[a-z]:/i.test(part))) {
    return undefined;
  }
  return kept.length > 1 ? kept.slice(1).join("/") : undefined; // strip: 1
}

/** Directories never reach here, so `isDir` is always false in npm's formula. */
function normalizeMode(mode: number): number {
  const normalized = ((mode | 0o666) & ~UMASK) | 0o600;
  // Keep the tarball's own executable bit so the store can restore it.
  return mode & 0o111 ? normalized | 0o111 : normalized;
}

function name(header: Uint8Array): string {
  const base = text(header.subarray(0, 100)).replace(/\0.*$/s, "");
  const prefix = text(header.subarray(345, 500)).replace(/\0.*$/s, "");
  return prefix ? `${prefix}/${base}` : base;
}

/** Octal, or base-256 for values too large for the field. Negative base-256 is not used by sizes. */
function num(header: Uint8Array, offset: number, length: number): number {
  const field = header.subarray(offset, offset + length);
  if ((field[0] ?? 0) & 0x80) {
    let value = 0n;
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return Number(value);
  }
  const parsed = Number.parseInt(text(field).replace(/[\0 ]/g, ""), 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function checksumOk(header: Uint8Array): boolean {
  const expected = num(header, 148, 8);
  // The checksum field itself counts as spaces. An indexed loop: an iterator here was 8,527
  // headers times 512 result objects on `next`, a tenth of its parse and most of its GC.
  let unsigned = 8 * 0x20;
  let signed = unsigned;
  for (let index = 0; index < BLOCK; index++) {
    if (index === 148) index = 156;
    const value = header[index]!;
    unsigned += value;
    signed += value > 0x7f ? value - 0x100 : value;
  }
  return expected === unsigned || expected === signed;
}

/** PAX records are `<byte length> <key>=<value>\n`, counted in bytes. */
function parsePax(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {};
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number.parseInt(text(data.subarray(at, space)), 10);
    if (!Number.isInteger(length) || length <= 0 || at + length > data.length) break;
    const record = text(data.subarray(space + 1, at + length)).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

function readUmask(): number {
  try {
    const value = globalThis.process?.umask?.();
    return typeof value === "number" ? value : 0o022;
  } catch {
    return 0o022;
  }
}

const padded = (size: number) => Math.ceil(size / BLOCK) * BLOCK;
const isZero = (block: Uint8Array) => block.every((byte) => byte === 0);
// `ignoreBOM` keeps a leading U+FEFF in a name, as Buffer did: stripping it would let
// `\uFEFFa.js` land on `a.js`.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true });
const text = (data: Uint8Array) => utf8.decode(data);

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "EBADTAR" });
}
