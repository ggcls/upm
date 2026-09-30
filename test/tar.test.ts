import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { constants, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { extractTar, type TarEntry } from "../src/tar.ts";

const BLOCK = 512;

interface Header {
  name?: string;
  prefix?: string;
  mode?: number;
  size?: number;
  type?: string;
  body?: string | Uint8Array;
  /** Corrupt the checksum on purpose. */
  badChecksum?: boolean;
  /** Encode the size field in base-256 instead of octal. */
  base256?: boolean;
}

function octal(block: Uint8Array, offset: number, length: number, value: number): void {
  const text = `${value.toString(8).padStart(length - 1, "0")}\0`;
  Buffer.from(text, "ascii").copy(block, offset);
}

function str(block: Uint8Array, offset: number, value: string): void {
  Buffer.from(value, "utf8").copy(block, offset);
}

function entry(header: Header): Uint8Array {
  const body =
    typeof header.body === "string" ? Buffer.from(header.body) : (header.body ?? Buffer.alloc(0));
  const block = Buffer.alloc(BLOCK);
  str(block, 0, header.name ?? "");
  octal(block, 100, 8, header.mode ?? 0o644);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  if (header.base256) {
    block[124] = 0x80;
    block.writeUInt32BE(header.size ?? body.length, 132);
  } else {
    octal(block, 124, 12, header.size ?? body.length);
  }
  octal(block, 136, 12, 0);
  str(block, 148, "        "); // checksum placeholder
  str(block, 156, header.type ?? "0");
  str(block, 257, "ustar\0");
  str(block, 263, "00");
  str(block, 345, header.prefix ?? "");
  let sum = 0;
  for (const byte of block) sum += byte;
  if (header.badChecksum) sum += 1;
  str(block, 148, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK);
  return Buffer.concat([block, body, padding]);
}

/** A whole archive, with the two trailing zero blocks. */
function tar(headers: Header[]): Uint8Array {
  return Buffer.concat([...headers.map((h) => entry(h)), Buffer.alloc(BLOCK * 2)]);
}

function pax(records: Record<string, string>, type: "x" | "g" = "x"): Header {
  const body = Object.entries(records)
    .map(([key, value]) => {
      const rest = ` ${key}=${value}\n`;
      // The length prefix counts itself, so grow it until it is consistent.
      let length = rest.length + 1;
      while (`${length}`.length + rest.length !== length) length = `${length}`.length + rest.length;
      return `${length}${rest}`;
    })
    .join("");
  return { name: "PaxHeader", type, body };
}

async function* chunked(data: Uint8Array, size = 1024): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}

async function collect(data: Uint8Array, chunk?: number): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  for await (const found of extractTar(chunked(data, chunk))) out.push(found);
  return out;
}

const paths = (entries: TarEntry[]) => entries.map((e) => e.path);
const text = (entry: TarEntry) => Buffer.from(entry.data).toString("utf8");

describe("extractTar", () => {
  it("strips the first component whatever it is called", async () => {
    const entries = await collect(
      tar([
        { name: "package/index.js", body: "hi" },
        { name: "weird-root/lib/a.js", body: "a" },
      ]),
    );
    expect(paths(entries)).toEqual(["index.js", "lib/a.js"]);
    expect(text(entries[0]!)).toBe("hi");
  });

  it("drops a single-component path", async () => {
    const entries = await collect(
      tar([
        { name: "README.md", body: "x" },
        { name: "package/a", body: "a" },
      ]),
    );
    expect(paths(entries)).toEqual(["a"]);
  });

  it("drops directories, links and devices", async () => {
    const entries = await collect(
      tar([
        { name: "package/dir/", type: "5" },
        { name: "package/link", type: "1" },
        { name: "package/sym", type: "2" },
        { name: "package/chr", type: "3" },
        { name: "package/blk", type: "4" },
        { name: "package/fifo", type: "6" },
        { name: "package/ok", body: "ok" },
      ]),
    );
    expect(paths(entries)).toEqual(["ok"]);
  });

  it("treats a contiguous file as a regular file", async () => {
    const entries = await collect(tar([{ name: "package/c.js", type: "7", body: "c" }]));
    expect(paths(entries)).toEqual(["c.js"]);
  });

  it("rejects path traversal", async () => {
    const entries = await collect(
      tar([
        { name: "../../etc/passwd", body: "bad" },
        { name: "/etc/passwd", body: "bad" },
        { name: "package/a/../../b", body: "bad" },
        { name: "package/../../../etc/shadow", body: "bad" },
        { name: "C:/windows/system32", body: "bad" },
        { name: "package/good.js", body: "good" },
      ]),
    );
    expect(paths(entries)).toEqual(["good.js"]);
  });

  it("rejects a drive letter anywhere past the first component, and keeps other colons", async () => {
    const entries = await collect(
      tar([
        { name: "package/C:/windows/x", body: "bad" },
        { name: "package/c:x.js", body: "bad" },
        { name: "package/lib/D:y.js", body: "bad" },
        { name: "package/lib/a:b.js", body: "bad" }, // one letter and a colon reads as a drive
        { name: "package/lib/ab:c.js", body: "ok" },
      ]),
    );
    expect(paths(entries)).toEqual(["lib/ab:c.js"]);
  });

  it("normalizes backslash separators", async () => {
    const entries = await collect(
      tar([
        { name: String.raw`package\lib\a.js`, body: "a" },
        { name: String.raw`package\..\..\etc\passwd`, body: "bad" },
      ]),
    );
    expect(paths(entries)).toEqual(["lib/a.js"]);
  });

  it("joins the ustar prefix field", async () => {
    const entries = await collect(tar([{ name: "deep/a.js", prefix: "package/lib", body: "a" }]));
    expect(paths(entries)).toEqual(["lib/deep/a.js"]);
  });

  it("uses a pax path override", async () => {
    const long = `package/${"nested/".repeat(30)}file.js`;
    const entries = await collect(
      tar([pax({ path: long }), { name: "package/short.js", body: "long" }]),
    );
    expect(paths(entries)).toEqual([long.slice("package/".length)]);
    expect(text(entries[0]!)).toBe("long");
  });

  it("applies a pax global header until replaced", async () => {
    const entries = await collect(
      tar([
        pax({ path: "package/from-global.js" }, "g"),
        { name: "package/a.js", body: "a" },
        pax({ path: "package/local.js" }),
        { name: "package/b.js", body: "b" },
      ]),
    );
    // The local `x` record wins over the global one for the entry that follows it.
    expect(paths(entries)).toEqual(["from-global.js", "local.js"]);
  });

  it("uses a GNU long name", async () => {
    const long = `package/${"a".repeat(150)}.js`;
    const entries = await collect(
      tar([
        { name: "././@LongLink", type: "L", body: `${long}\0` },
        { name: "package/x", body: "x" },
      ]),
    );
    expect(paths(entries)).toEqual([long.slice("package/".length)]);
  });

  it("normalizes modes and keeps the executable bit", async () => {
    const entries = await collect(
      tar([
        { name: "package/bin.js", mode: 0o755, body: "#!" },
        { name: "package/lib.js", mode: 0o644, body: "x" },
        { name: "package/odd.js", mode: 0o400, body: "x" },
      ]),
    );
    expect(entries[0]!.mode & 0o111).toBe(0o111);
    expect(entries[1]!.mode & 0o111).toBe(0);
    expect(entries[2]!.mode & 0o111).toBe(0);
    for (const found of entries) expect(found.mode & 0o600).toBe(0o600);
  });

  it("reads zero-byte files and padded bodies", async () => {
    const odd = "x".repeat(513);
    const entries = await collect(
      tar([
        { name: "package/empty", body: "" },
        { name: "package/odd", body: odd },
        { name: "package/exact", body: "y".repeat(512) },
        { name: "package/after", body: "after" },
      ]),
    );
    expect(paths(entries)).toEqual(["empty", "odd", "exact", "after"]);
    expect(entries[0]!.data.length).toBe(0);
    expect(text(entries[1]!)).toBe(odd);
    expect(text(entries[3]!)).toBe("after");
  });

  it("reads a base-256 size field", async () => {
    const entries = await collect(tar([{ name: "package/big.js", base256: true, body: "hello" }]));
    expect(text(entries[0]!)).toBe("hello");
  });

  it("skips an entry with a bad header checksum", async () => {
    const entries = await collect(
      tar([
        { name: "package/bad.js", body: "bad", badChecksum: true },
        { name: "package/good.js", body: "good" },
      ]),
    );
    expect(paths(entries)).toEqual(["good.js"]);
  });

  it("throws EBADTAR on a truncated archive", async () => {
    const full = tar([{ name: "package/a.js", body: "a".repeat(600) }]);
    const cut = full.subarray(0, BLOCK + 200);
    await expect(collect(cut)).rejects.toMatchObject({ code: "EBADTAR" });
  });

  it("throws EBADTAR on a truncated header", async () => {
    const full = tar([{ name: "package/a.js", body: "a" }]);
    await expect(collect(full.subarray(0, 300))).rejects.toMatchObject({ code: "EBADTAR" });
  });

  it("stops at the end-of-archive marker", async () => {
    const data = Buffer.concat([
      tar([{ name: "package/a.js", body: "a" }]),
      Buffer.from("garbage"),
    ]);
    expect(paths(await collect(data))).toEqual(["a.js"]);
  });

  it("gunzips and passes plain tar through", async () => {
    const plain = tar([{ name: "package/a.js", body: "a" }]);
    expect(paths(await collect(gzipSync(plain)))).toEqual(["a.js"]);
    expect(paths(await collect(plain))).toEqual(["a.js"]);
  });

  it("survives any chunk boundary", async () => {
    const data = gzipSync(
      tar([
        { name: "package/a.js", body: "a".repeat(2000) },
        { name: "package/b.js", body: "b" },
      ]),
    );
    for (const size of [1, 3, 512, 999]) {
      const entries = await collect(data, size);
      expect(paths(entries)).toEqual(["a.js", "b.js"]);
      expect(entries[0]!.data.length).toBe(2000);
    }
  });

  it("reads entries that span the inflate steps back whole", async () => {
    // Inflated a MiB at a time, so a 3 MiB file and the small ones after it cross step
    // boundaries; the reader copies exactly what each entry needs and hands out views for
    // the rest.
    const big = randomBytes(3 * 1024 * 1024 + 77);
    const data = gzipSync(
      tar([
        { name: "package/big.bin", body: big },
        { name: "package/a.js", body: "a".repeat(700) },
        { name: "package/b.js", body: "b" },
      ]),
    );
    const entries = await collect(data, 300_000);
    expect(paths(entries)).toEqual(["big.bin", "a.js", "b.js"]);
    expect(Buffer.from(entries[0]!.data).equals(big)).toBe(true);
    expect(text(entries[1]!)).toBe("a".repeat(700));
    expect(text(entries[2]!)).toBe("b");
  });

  it("reports a corrupt gzip as EBADTAR whether it came whole or in pieces", async () => {
    // One block is inflated in a single call, more than one through a stream; both must fail
    // the same way, with zlib's code named and nothing of zlib's own error shape leaking.
    const good = gzipSync(tar([{ name: "package/a.js", body: "a".repeat(5000) }]));
    const bad = Buffer.concat([good.subarray(0, 40), Buffer.from("garbage".repeat(40))]);

    await expect(collect(bad)).rejects.toMatchObject({ code: "EBADTAR", message: /Corrupt gzip/ });
    await expect(collect(bad, 64)).rejects.toMatchObject({
      code: "EBADTAR",
      message: /Corrupt gzip/,
    });
  });

  it("refuses a gzip that inflates past the ceiling in one call", async () => {
    // 1 GiB of zeros is under 1 MiB gzipped, so a whole block of it takes the one-shot path.
    // `maxOutputLength` is a ceiling, not a pre-check: zlib inflates up to it (~1 GB held,
    // ~0.7 s) and throws on the byte past it. The stream is lazy: it inflates only what the
    // tar reader asks for, and this reader stops at the first zero blocks.
    // Run-length strategy: a quarter of the time to compress a gigabyte of the same byte.
    const bomb = gzipSync(Buffer.alloc(1024 * 1024 * 1024 + 1), { strategy: constants.Z_RLE });
    expect(bomb.length).toBeLessThan(1024 * 1024);

    await expect(collect(bomb, bomb.length)).rejects.toMatchObject({
      code: "EBADTAR",
      message: /inflates past/,
    });
    expect(await collect(bomb, 64 * 1024)).toEqual([]);
  });

  it("handles an empty source", async () => {
    expect(await collect(Buffer.alloc(0))).toEqual([]);
  });

  it("refuses an entry that declares more bytes than we will hold", async () => {
    // A few KB of tar can claim gigabytes; buffering it would exhaust memory.
    const archive = tar([{ name: "package/bomb.bin", size: 1_572_864_000, body: "x" }]);

    await expect(collect(archive)).rejects.toMatchObject({ code: "EBADTAR" });
  });

  it("does not carry pax records past a corrupt header", async () => {
    const archive = tar([
      pax({ path: "leaked.js" }),
      { name: "package/corrupt.js", body: "bad", badChecksum: true },
      { name: "package/next.js", body: "good" },
    ]);

    expect(paths(await collect(archive))).toEqual(["next.js"]);
  });
});
