// Tarball entry names Windows treats specially: drive letters, stream colons, reserved device
// names, trailing dots and spaces, case folding, paths past MAX_PATH. On Windows these print
// what happened, as JSON lines starting `windows-names`, and assert only that nothing lands
// outside the installed package. On other platforms they pin what upm keeps and drops.
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as upm from "../src/index.ts";
import { hashOf } from "./hash.ts";

const windows = process.platform === "win32";
const marker = `upm-probe-${randomBytes(4).toString("hex")}`;
const long = `${"d".repeat(200)}/${"e".repeat(80)}.js`;

interface Case {
  name: string;
  entries: { path: string; data: string }[];
}

/** One entry each, beside a plain `ok.js`, so one odd name can't hide what another does. */
const cases: Case[] = [
  { name: "drive root", entries: [{ path: `C:/${marker}.js`, data: "drive" }] },
  { name: "drive relative", entries: [{ path: `C:${marker}2.js`, data: "drive2" }] },
  { name: "stream colon", entries: [{ path: "a:b.js", data: "stream" }] },
  { name: "nested drive", entries: [{ path: `sub/C:/${marker}3.js`, data: "nested" }] },
  { name: "CON", entries: [{ path: "CON", data: "con" }] },
  { name: "aux.js", entries: [{ path: "aux.js", data: "aux" }] },
  { name: "nul.txt", entries: [{ path: "nul.txt", data: "nul" }] },
  { name: "COM1.txt", entries: [{ path: "COM1.txt", data: "com1" }] },
  { name: "trailing dot", entries: [{ path: "trail.", data: "dot" }] },
  { name: "trailing space", entries: [{ path: "trail ", data: "space" }] },
  {
    name: "case fold",
    entries: [
      { path: "A.js", data: "upper" },
      { path: "a.js", data: "lower" },
    ],
  },
  { name: "long path", entries: [{ path: long, data: "long" }] },
];

let dir: string;
let server: Server;
let tarball: Uint8Array;
let base: upm.InstallOptions;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "upm-names-"));
  tarball = pack([]);
  server = createServer((request, response) => {
    if (request.url === "/probe/-/probe-1.0.0.tgz") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(tarball));
      return;
    }
    if (request.url !== "/probe") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"Not found"}');
      return;
    }
    const manifest = {
      name: "probe",
      version: "1.0.0",
      dist: { tarball: `${registry()}/probe/-/probe-1.0.0.tgz`, integrity: hashOf(tarball) },
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        name: "probe",
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": manifest },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = {
    dir,
    store: join(dir, "store"),
    registry: registry(),
    log: () => {},
    experimental: { resolvePool: 0, linkPool: { size: 0 } },
  };
  await writeFile(join(dir, "package.json"), '{"dependencies":{"probe":"1.0.0"}}');
});

afterEach(async () => {
  await new Promise((done) => server.close(done));
  // A stray found outside was already asserted on; remove it so it can't outlive the run.
  for (const path of await strays()) await rm(path, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

/** One JSON line for the CI log, with the long path's segments shortened. */
function print(fact: object): void {
  const line = JSON.stringify(fact)
    .replaceAll("d".repeat(200), "<d*200>")
    .replaceAll("e".repeat(80), "<e*80>");
  console.log(`windows-names ${line}`);
}

function registry(): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A ustar block; `L` carries a GNU long name for the entry after it. */
function block(path: string, data: Buffer, type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(path.slice(0, 100), 0, 100, "utf8");
  header.write("0000644\0", 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8);
  header.write(type, 156, 1);
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function pack(entries: Case["entries"]): Uint8Array {
  const blocks = [{ path: "ok.js", data: "ok" }, ...entries].flatMap(({ path, data }) => {
    const full = `package/${path}`;
    const body = Buffer.from(data);
    return full.length > 100
      ? [block("././@LongLink", Buffer.from(`${full}\0`), "L"), block(full, body)]
      : [block(full, body)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

/** Files named for this run's marker in places a drive letter could reach. */
async function strays(): Promise<string[]> {
  const places = new Set([
    parse(tmpdir()).root,
    dirname(dir),
    process.cwd(),
    parse(process.cwd()).root,
    homedir(),
  ]);
  if (windows) places.add("C:\\");
  const found: string[] = [];
  for (const place of places) {
    const names = await readdir(place).catch(() => [] as string[]);
    for (const name of names) if (name.includes(marker)) found.push(join(place, name));
  }
  return found;
}

/** Every path under `root`, relative and with `/`, or the error that stopped the walk. */
async function walk(root: string): Promise<string[] | string> {
  try {
    const names = await readdir(root, { recursive: true });
    return names.map((name) => name.split(sep).join("/")).sort();
  } catch (error) {
    return String((error as NodeJS.ErrnoException).code ?? error);
  }
}

async function probe(entries: Case["entries"]) {
  tarball = pack(entries);
  const fact: Record<string, unknown> = {};
  try {
    const result = await upm.install(base);
    fact["install"] = { ok: true, repaired: result.stats.repaired };
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    fact["install"] = { ok: false, code, message: message.split("\n")[0] };
  }
  const pkg = await realpath(join(dir, "node_modules", "probe")).catch(() => undefined);
  const files = pkg ? await walk(pkg) : "missing";
  fact["files"] = files;
  if (pkg && Array.isArray(files)) {
    const contents: Record<string, string> = {};
    for (const file of files) {
      const text = await readFile(join(pkg, file), "utf8").catch(
        (error: NodeJS.ErrnoException) => `<${error.code}>`,
      );
      if (text.length < 20) contents[file] = text;
    }
    fact["contents"] = contents;
  }
  if ((fact["install"] as { ok: boolean }).ok) {
    fact["repeat"] = await upm.install(base).then(
      (result) => ({ upToDate: result.upToDate }),
      (error: NodeJS.ErrnoException) => ({ code: error.code }),
    );
    fact["verify"] = await upm.install({ ...base, verify: true }).then(
      (result) => ({ upToDate: result.upToDate, repaired: result.stats.repaired }),
      (error: NodeJS.ErrnoException) => ({ code: error.code }),
    );
    fact["afterVerify"] = await upm.install(base).then(
      (result) => ({ upToDate: result.upToDate }),
      (error: NodeJS.ErrnoException) => ({ code: error.code }),
    );
  }
  // Anything this run's marker names inside the project must sit in the package itself.
  const all = await walk(dir);
  const inProject = Array.isArray(all) ? all.filter((path) => path.includes(marker)) : [];
  const outside = inProject.filter(
    (path) => !pkg || relative(pkg, join(dir, path)).startsWith(".."),
  );
  return { fact, pkg, outside, strays: await strays() };
}

describe.runIf(windows)("tar entry names on windows", () => {
  for (const { name, entries } of cases) {
    it(`keeps ${name} inside the package`, async () => {
      const { fact, outside, strays: found } = await probe(entries);
      print({ case: name, ...fact, outside, strays: found });
      expect(found).toEqual([]);
      expect(outside).toEqual([]);
    });
  }

  it("keeps all of them together inside the package", async () => {
    const { fact, outside, strays: found } = await probe(cases.flatMap((c) => c.entries));
    print({ case: "all", ...fact, outside, strays: found });
    expect(found).toEqual([]);
    expect(outside).toEqual([]);
  });
});

describe.skipIf(windows)("tar entry names elsewhere", () => {
  it("drops drive letters and stream colons, and keeps names only windows reserves", async () => {
    const { fact, outside, strays: found } = await probe(cases.flatMap((c) => c.entries));
    expect(found).toEqual([]);
    expect(outside).toEqual([]);
    expect(fact["install"]).toMatchObject({ ok: true });
    const files = fact["files"] as string[];
    for (const kept of [
      "ok.js",
      "CON",
      "aux.js",
      "nul.txt",
      "COM1.txt",
      "trail.",
      "trail ",
      long,
    ]) {
      expect(files).toContain(kept);
    }
    expect(files.some((file) => file.includes(":"))).toBe(false);
    // macOS folds case by default, so only a case-sensitive disk keeps both.
    if (process.platform === "linux")
      expect(files).toEqual(expect.arrayContaining(["A.js", "a.js"]));
    expect(fact["repeat"]).toEqual({ upToDate: true });
    expect(fact["verify"]).toMatchObject({ upToDate: false });
    expect(fact["afterVerify"]).toEqual({ upToDate: true });
  });
});
