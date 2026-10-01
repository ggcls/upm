import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { parseIntegrity } from "../src/integrity.ts";
import { builtin } from "../src/builtin.ts";
import { hashOf } from "./hash.ts";
import { assemble, createWriter } from "../src/unpack.ts";
import { makeTarball } from "./tarball.ts";

const writer = createWriter(join(tmpdir(), "upm-shard-test"));

/**
 * What `contentPath` must return, derived only from `parseIntegrity`. The fast path in
 * `shardOf` is an optimisation of exactly this, so the two must never disagree.
 */
function oracle(hash: string): { shard: string; name: string } {
  const { algorithm, digest } = parseIntegrity(hash);
  const safe = digest.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return { shard: safe.slice(0, 2), name: `${algorithm}-${safe.slice(2)}` };
}

/** Split a store path back into the two parts `shardOf` decides. */
function actual(hash: string): { shard: string; name: string } {
  const path = writer.contentPath(hash, false);
  return { shard: basename(dirname(path)), name: basename(path) };
}

function agrees(hash: string): void {
  expect(actual(hash)).toEqual(oracle(hash));
}

/** A digest of the right byte length for `algorithm`, seeded so it is stable across runs. */
function digestOf(algorithm: string, bytes: number, seed: number): string {
  const raw = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) raw[i] = (i * 31 + seed) % 256;
  return `${algorithm}-${raw.toString("base64")}`;
}

const CANONICAL = {
  sha512: digestOf("sha512", 64, 1),
  sha384: digestOf("sha384", 48, 2),
  sha256: digestOf("sha256", 32, 3),
  sha1: digestOf("sha1", 20, 4),
};

describe("contentPath fast path", () => {
  it("agrees with parseIntegrity on a canonical digest of every algorithm", () => {
    for (const hash of Object.values(CANONICAL)) agrees(hash);
  });

  it("puts content under a two-character shard and keeps the algorithm in the name", () => {
    const { shard, name } = actual(CANONICAL.sha512);
    expect(shard).toHaveLength(2);
    expect(name.startsWith("sha512-")).toBe(true);
  });

  it("never emits a base64 character that is unsafe in a path segment", () => {
    // `+` and `/` must become `-` and `_`, and padding must be dropped: `/` would otherwise
    // split the path and `+`/`=` are merely ugly.
    for (let seed = 0; seed < 64; seed++) {
      const hash = digestOf("sha512", 64, seed);
      const { shard, name } = actual(hash);
      agrees(hash);
      expect(`${shard}${name}`).not.toMatch(/[+/=]/);
    }
  });

  it("agrees with parseIntegrity across many random digests", () => {
    for (let seed = 0; seed < 128; seed++) {
      agrees(digestOf("sha512", 64, seed));
      agrees(digestOf("sha256", 32, seed));
      agrees(digestOf("sha1", 20, seed));
      agrees(digestOf("sha384", 48, seed));
    }
  });

  it("indexPath shards a digest the same way contentPath does", () => {
    const index = writer.indexPath(CANONICAL.sha512);
    expect(basename(dirname(index))).toBe(oracle(CANONICAL.sha512).shard);
    expect(basename(index)).toBe(`${oracle(CANONICAL.sha512).name}.json`);
  });

  it("gives exec content a distinct path from non-exec content", () => {
    expect(writer.contentPath(CANONICAL.sha512, true)).toBe(
      `${writer.contentPath(CANONICAL.sha512, false)}-exec`,
    );
  });

  it("spells a blob with the platform separator, as the collector's join walk lists it", async () => {
    // `blob` goes into the index as written; the collector compares `blobPath` against
    // `path.join(files, shard, name)`, so a `/` in it on Windows would never match a live blob.
    vi.resetModules();
    vi.doMock("../src/builtin.ts", async (importOriginal) => {
      const real = (await importOriginal<typeof import("../src/builtin.ts")>()).builtin;
      return { builtin: { ...real, path: win32 } };
    });
    try {
      const { createWriter: create } = await import("../src/unpack.ts");
      const { shard, name } = oracle(CANONICAL.sha512);
      const on = create("C:\\store");
      expect(on.contentPath(CANONICAL.sha512, false)).toBe(
        win32.join("C:\\store", "files", shard, name),
      );
      expect(on.blobPath(`${shard}\\${name}`)).toBe(on.contentPath(CANONICAL.sha512, false));
    } finally {
      vi.doUnmock("../src/builtin.ts");
      vi.resetModules();
    }
  });
});

describe("contentPath fast-path gate", () => {
  it("falls through when the base64 is the wrong length for its algorithm", () => {
    // Right shape, one character short or long: the fast path must not take these.
    const body = CANONICAL.sha512.slice("sha512-".length, -2);
    expect(() => actual(`sha512-${body.slice(0, -1)}==`)).toThrow(/Invalid integrity/);
    expect(() => actual(`sha512-${body}A==`)).toThrow(/Invalid integrity/);
    // A sha256-length digest wearing a sha512 prefix is not a sha512.
    expect(() => actual(`sha512-${CANONICAL.sha256.slice("sha256-".length)}`)).toThrow(
      /Invalid integrity/,
    );
  });

  it("rejects an unknown algorithm prefix", () => {
    const body = CANONICAL.sha512.slice("sha512-".length);
    expect(() => actual(`sha999-${body}`)).toThrow(/Invalid integrity/);
    expect(() => actual(`md5-${body}`)).toThrow(/Invalid integrity/);
    expect(() => actual(`SHA512-${body}`)).toThrow(/Invalid integrity/);
    expect(() => actual(body)).toThrow(/Invalid integrity/); // no prefix at all
  });

  it("still agrees when parseIntegrity has to normalise the digest", () => {
    // SSRI tolerates trailing options and surrounding space, and picks the strongest of
    // several entries. None of those may reach the fast path, and all must still resolve.
    agrees(`${CANONICAL.sha512}?foo=bar`);
    agrees(`  ${CANONICAL.sha512}  `);
    agrees(`${CANONICAL.sha1} ${CANONICAL.sha512}`);
    expect(actual(`${CANONICAL.sha1} ${CANONICAL.sha512}`).name.startsWith("sha512-")).toBe(true);
  });

  it("does not take the fast path on URL-safe base64", () => {
    // `-` and `_` are what the store *writes*, not what an integrity string contains, so a
    // base64url digest is not canonical input and parseIntegrity must reject it.
    const plus = digestOf("sha512", 64, 11).slice("sha512-".length);
    if (plus.includes("+") || plus.includes("/")) {
      const url = plus.replaceAll("+", "-").replaceAll("/", "_");
      expect(() => actual(`sha512-${url}`)).toThrow(/Invalid integrity/);
    }
  });

  it("does not take the fast path on a digest whose padding bits are not canonical", () => {
    // 86 base64 characters hold 516 bits but sha512 is 512, so the last character has 4 slack
    // bits. With them set, decoding and re-encoding yields a *different* string — the fast path
    // must fall through rather than invent a second path for one digest.
    const body = CANONICAL.sha512.slice("sha512-".length, -2);
    const bent = `sha512-${body.slice(0, -1)}B==`;
    expect(Buffer.from(`${body.slice(0, -1)}B==`, "base64")).toHaveLength(64); // still decodes
    agrees(bent);
    // And it must land where the canonical spelling of the same bytes lands.
    const settled = parseIntegrity(bent);
    expect(actual(bent)).toEqual(oracle(`sha512-${settled.digest}`));
  });

  it("rejects malformed junk", () => {
    for (const bad of ["", "   ", "sha512-", "-", "sha512", "sha512-!!!", "sha512-a/../../b"]) {
      expect(() => actual(bad)).toThrow(/Invalid integrity/);
    }
  });

  it("never lets a path separator or traversal escape into a segment", () => {
    for (const bad of ["sha512-../../etc/passwd", "sha512-a/b", `sha512-${"/".repeat(86)}==`]) {
      let segments: { shard: string; name: string } | undefined;
      try {
        segments = actual(bad);
      } catch {
        continue; // rejected outright, which is the preferred answer
      }
      expect(`${segments.shard}${segments.name}`).not.toMatch(/[/.]/);
    }
  });
});

describe("put against a store changing underneath it", () => {
  it("remakes a shard directory a concurrent prune compacted away", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upm-put-"));
    const writer = createWriter(dir);
    const data = Buffer.from("content");
    const file = writer.contentPath(hashOf(data), false);

    await writer.ensureDir(dirname(file));
    // What `compact` does to a shard that is empty for the moment. `ensureDir` is memoized,
    // so nothing would ever create it again.
    await rmdir(dirname(file));

    await expect(writer.put(file, data, 0o444)).resolves.toBeUndefined();
    expect(await readFile(file, "utf8")).toBe("content");
    await rm(dir, { recursive: true, force: true });
  });
});

describe.each(["unpack", "plain tar", "packed", "spooled"])("%s bin shebangs", (route) => {
  it.each([
    {
      label: "strips only the shebang CR and keeps body CRLFs",
      input: Buffer.from('#!/usr/bin/env node\r\nconsole.log("hello")\r\n'),
      expected: Buffer.from('#!/usr/bin/env node\nconsole.log("hello")\r\n'),
      declared: true,
    },
    {
      label: "keeps an LF shebang and body CRLFs",
      input: Buffer.from('#!/usr/bin/env node\nconsole.log("hello")\r\n'),
      declared: true,
    },
    {
      label: "keeps an undeclared executable's CRLF shebang",
      input: Buffer.from('#!/usr/bin/env node\r\nconsole.log("hello")\r\n'),
      declared: false,
      mode: 0o755,
    },
    {
      label: "keeps an ordinary file's CRLF shebang",
      input: Buffer.from('#!/usr/bin/env node\r\nconsole.log("hello")\r\n'),
      declared: false,
    },
    {
      label: "keeps a declared bin without a shebang",
      input: Buffer.from('console.log("hello")\r\n'),
      declared: true,
    },
    {
      label: "keeps an unterminated shebang",
      input: Buffer.from("#!/usr/bin/env node\r"),
      declared: true,
    },
    {
      label: "keeps CRs inside the shebang",
      input: Buffer.from("#!node\r --flag\r\nbody\r\n"),
      expected: Buffer.from("#!node\r --flag\nbody\r\n"),
      declared: true,
    },
    {
      label: "strips a shebang CR at a rewrite chunk boundary",
      input: Buffer.from(`#!${"x".repeat(65533)}\r\nbody\r\n`),
      expected: Buffer.from(`#!${"x".repeat(65533)}\nbody\r\n`),
      declared: true,
    },
  ])("$label", async ({ input, expected = input, declared, mode = 0o644 }) => {
    const dir = await mkdtemp(join(tmpdir(), "upm-shebang-"));
    try {
      const suffix = route === "spooled" ? Buffer.alloc(4 * 1024 * 1024, 0x78) : Buffer.alloc(0);
      const data = Buffer.concat([input, suffix]);
      const normalized = Buffer.concat([expected, suffix]);
      // The manifest arrives last: the bin's bytes can already be hashed and spooled.
      const manifest = JSON.stringify({ name: "p", bin: declared ? { p: "cli.js" } : {} });
      const archive = makeTarball([
        { path: "cli.js", data, mode },
        { path: "package.json", data: manifest },
      ]);
      const tarball = route === "plain tar" ? gunzipSync(archive) : archive;
      const integrity = hashOf(tarball);
      const writer = createWriter(dir, { blocking: route === "spooled" });
      let index;
      if (route === "unpack" || route === "plain tar") {
        index = await writer.unpack(integrity, [tarball], false);
        expect(hashOf(tarball)).toBe(integrity);
      } else {
        async function* source() {
          for (let at = 0; at < tarball.length; at += 65536) yield tarball.subarray(at, at + 65536);
        }
        const parts = await writer.split(source(), 2);
        const file = parts.flatMap((part) => part.files).find((file) => file.path === "cli.js")!;
        expect(Boolean(file.temp)).toBe(route === "spooled");
        if (file.temp) expect((await readFile(file.temp)).equals(normalized)).toBe(true);
        const blobs = await Promise.all(parts.map((part) => writer.writePart(part, false)));
        index = assemble(integrity, parts, blobs);
        if (route === "spooled") {
          const buffered = createWriter(join(dir, "buffered"));
          expect(index).toEqual(await buffered.unpack(integrity, [tarball], false));
          expect(await readdir(join(dir, "files"))).not.toContainEqual(
            expect.stringMatching(/\.tmp$/),
          );
        }
      }
      const file = index.files.find((file) => file.path === "cli.js")!;
      expect((await readFile(writer.blobPath(file.blob))).equals(normalized)).toBe(true);
      expect(writer.blobPath(file.blob)).toBe(
        writer.contentPath(hashOf(normalized), declared || (mode & 0o111) !== 0),
      );
      expect(file.size).toBe(normalized.length);
      expect(index.unpackedSize).toBe(normalized.length + Buffer.byteLength(manifest));
      expect(index.integrity).toBe(integrity);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("spooled bin normalization", () => {
  const prefix = Buffer.from('#!/usr/bin/env node\r\nconsole.log("hello")\r\n');
  const body = Buffer.alloc(4 * 1024 * 1024, 0x78);
  const data = Buffer.concat([prefix, body]);
  const normalized = Buffer.concat([
    Buffer.from('#!/usr/bin/env node\nconsole.log("hello")\r\n'),
    body,
  ]);
  const tarball = gunzipSync(
    makeTarball([
      { path: "cli.js", data },
      { path: "package.json", data: '{"name":"p","bin":{"p":"cli.js"}}' },
    ]),
  );

  async function* source() {
    // One chunk ends after #, one after !, and another after the shebang CR.
    const cuts = [0, 513, 514, 512 + prefix.indexOf(0x0a), tarball.length];
    for (let i = 1; i < cuts.length; i++) yield tarball.subarray(cuts[i - 1], cuts[i]);
  }

  it("handles #! and CRLF split across source chunks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upm-spool-shebang-"));
    try {
      const writer = createWriter(dir, { blocking: true });
      const integrity = hashOf(tarball);
      const parts = await writer.split(source(), 1);
      const blobs = await Promise.all(parts.map((part) => writer.writePart(part, false)));
      const index = assemble(integrity, parts, blobs);
      const file = index.files.find((file) => file.path === "cli.js")!;
      expect((await readFile(writer.blobPath(file.blob))).equals(normalized)).toBe(true);
      expect(writer.blobPath(file.blob)).toBe(writer.contentPath(hashOf(normalized), true));
      expect(file.size).toBe(normalized.length);
      expect(hashOf(tarball)).toBe(integrity);
      expect(await readdir(join(dir, "files"))).not.toContainEqual(expect.stringMatching(/\.tmp$/));
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("removes the original and replacement temps when the replay fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "upm-spool-shebang-"));
    const failed = new Error("Cannot read spool");
    const reader = vi.spyOn(builtin.fs, "createReadStream").mockImplementation(() => {
      throw failed;
    });
    try {
      const writer = createWriter(dir, { blocking: true });
      await expect(writer.split(source(), 1)).rejects.toBe(failed);
      expect(await readdir(join(dir, "files"))).toEqual([]);
    } finally {
      reader.mockRestore();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
