// registry.ts — a local npm registry for the benchmark: record the real one, then replay it.
//
//   node registry.ts record <dir> [--upstream <url>] [--port <n>] [--plain]
//   node registry.ts replay <dir> [--latency <factor>]
//   node registry.ts settle <dir> <runs.jsonl>
//
// record proxies every request to the upstream registry and keeps the request, the response
// and its timing in <dir>. replay answers the same requests from <dir> alone: it waits the
// recorded time to first byte, then spreads the body over the recorded transfer time. Every
// run then sees the same documents at the same speed, whatever the network does.
//
// A manager uses the registry under `/~<runner>/<version>/`, so each response is kept as that
// manager's. settle, after a recording, lists in <dir>/recorded each runner and fixture of the
// bench.sh results whose runs all succeeded, and drops what older versions of those runners
// recorded, so a recording holds one version of each manager.
//
// <dir> holds meta.json (origin, upstream, start time), index.jsonl (one line per recorded
// response), bodies/<sha256> and recorded. Recording into a directory that has them adds to it.
// JSON bodies are stored with the upstream origin replaced by this server's, so tarballs come
// here too, and a recording replays on the port and scheme it was recorded on.
//
// A new recording is served over TLS, as the live registry is, with HTTP/2 offered by ALPN
// beside HTTP/1.1: a manager pays its handshakes and picks its protocol as it would there.
// tls/ holds a CA the managers are told to trust (ca.pem) and the server's certificate, made
// with openssl. --plain records over http instead.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, Agent, createServer, request } from "node:http";
import { createSecureServer } from "node:http2";
import { Agent as TlsAgent, request as tlsRequest } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

interface Meta {
  origin: string;
  upstream: string;
  /** Epoch seconds the first recording started: `BENCH_AGE_FROM` for the release-age gate. */
  recorded: number;
}

/** One recorded response. `key` is what replay matches first; `url` is without the tag. */
interface Entry {
  key: string;
  runner: string;
  version: string;
  method: string;
  url: string;
  accept: string;
  encoding: string;
  conditional: boolean;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  ttfb: number;
  ms: number;
}

type Asked = Omit<Entry, "status" | "headers" | "body" | "ttfb" | "ms">;

// Response headers worth replaying. Date is this server's; age is the CDN's as recorded, so a
// cache counts the same freshness left as it did against the live registry.
const KEEP = [
  "age",
  "content-type",
  "content-encoding",
  "etag",
  "last-modified",
  "cache-control",
  "vary",
  "location",
];
const CORGI = "application/vnd.npm.install-v1+json";
const CHUNK = 64 * 1024;
// `~` cannot start a package name, so the tag never reads as one.
const TAG = /^\/~([^/]+)\/([^/]+)(\/.*)$/;

const [mode, dir, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
if (!["record", "replay", "settle"].includes(mode!) || !dir || (mode === "settle" && !rest[0])) {
  console.error("usage: node registry.ts record <dir> [--upstream <url>] [--port <n>]");
  console.error("       node registry.ts replay <dir> [--latency <factor>]");
  console.error("       node registry.ts settle <dir> <runs.jsonl>");
  process.exit(2);
}

const metaFile = join(dir, "meta.json");
const indexFile = join(dir, "index.jsonl");
const recordedFile = join(dir, "recorded");
const bodies = join(dir, "bodies");
const tls = join(dir, "tls");
const old: Meta | undefined = existsSync(metaFile)
  ? JSON.parse(readFileSync(metaFile, "utf8"))
  : undefined;

const stats = { served: 0, near: 0, missed: 0, recorded: 0 };
const requestOf = (req: IncomingMessage): Asked => {
  const [, runner = "", version = "", url = req.url ?? "/"] = TAG.exec(req.url ?? "") ?? [];
  const e = {
    runner,
    version,
    method: req.method ?? "GET",
    url,
    accept: req.headers.accept ?? "",
    encoding: req.headers["accept-encoding"] ?? "",
    conditional: !!(req.headers["if-none-match"] || req.headers["if-modified-since"]),
  };
  return {
    ...e,
    key: `${e.runner}@${e.version} ${e.method} ${e.url} ${e.accept} ${e.encoding} ${e.conditional}`,
  };
};
const tagOf = (e: Pick<Entry, "runner" | "version">) =>
  e.runner ? `/~${e.runner}/${e.version}` : "";

// Async, on libuv's threads: re-gzipping a 65 MB document on the event loop took half a second
// and delayed every response in flight, and so its recorded time.
const coder = (fn: (b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void) =>
  promisify(fn) as (b: Buffer) => Promise<Buffer>;
const decoders: Record<string, (b: Buffer) => Promise<Buffer>> = {
  gzip: coder(zlib.gunzip),
  "x-gzip": coder(zlib.gunzip),
  deflate: coder(zlib.inflate),
  br: coder(zlib.brotliDecompress),
  ...(zlib.zstdDecompress && { zstd: coder(zlib.zstdDecompress) }),
};
const encoders: Record<string, (b: Buffer) => Promise<Buffer>> = {
  gzip: coder(zlib.gzip),
  "x-gzip": coder(zlib.gzip),
  deflate: coder(zlib.deflate),
  br: coder(zlib.brotliCompress),
  ...(zlib.zstdCompress && { zstd: coder(zlib.zstdCompress) }),
};

if (mode === "settle") {
  settle(rest[0]!);
  process.exit(0);
}

let meta: Meta;
let handle: (req: IncomingMessage, res: ServerResponse) => void;

if (mode === "record") {
  const upstream = (option("--upstream") ?? old?.upstream ?? "https://registry.npmjs.org").replace(
    /\/$/,
    "",
  );
  if (old && old.upstream !== upstream) throw new Error(`${dir} was recorded from ${old.upstream}`);
  const scheme = rest.includes("--plain") ? "http" : "https";
  const origin = old?.origin ?? `${scheme}://127.0.0.1:${option("--port") ?? 4880}`;
  meta = old ?? { origin, upstream, recorded: Math.floor(Date.now() / 1000) };
  mkdirSync(bodies, { recursive: true });
  const seen = new Set<string>();
  const agent = upstream.startsWith("https:")
    ? new TlsAgent({ keepAlive: true, maxSockets: 64 })
    : new Agent({ keepAlive: true, maxSockets: 64 });
  const send = upstream.startsWith("https:") ? tlsRequest : request;
  const forward = [
    "accept",
    "accept-encoding",
    "if-none-match",
    "if-modified-since",
    "user-agent",
    "npm-command",
  ];

  handle = (req, res) => {
    const asked = requestOf(req);
    // Urls in the response lead back here under the same tag.
    const here = origin + tagOf(asked) + "/";
    const headers: Record<string, string> = {};
    for (const name of forward) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    // Timed from when the request goes out on a connected socket. A wait for one of the
    // pool's sockets, or a new connection's handshake, is the proxy's, not the registry's: a
    // burst of requests would otherwise record its queue as latency for every manager.
    let t0 = performance.now();
    const up = send(
      new URL("." + asked.url, upstream + "/"),
      { method: asked.method, headers, agent },
      (r) => {
        const ttfb = performance.now() - t0;
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => {
          const ms = performance.now() - t0;
          const status = r.statusCode ?? 502;
          store(asked, status, r.headers, Buffer.concat(chunks), ttfb, ms, here).then(
            ({ headers: kept, body }) => {
              res.writeHead(status, { ...kept, "content-length": body.length });
              res.end(asked.method === "HEAD" ? undefined : body);
            },
            (error) => fail(res, error),
          );
        });
        r.on("error", (error) => fail(res, error));
      },
    );
    up.on("socket", (socket) => {
      const start = () => (t0 = performance.now());
      if (socket.connecting)
        socket.once(upstream.startsWith("https:") ? "secureConnect" : "connect", start);
      else start();
    });
    up.on("error", (error) => fail(res, error));
    req.pipe(up);
  };

  /** Keeps one response: its body under its hash, then its line in the index. */
  const store = async (
    asked: Asked,
    status: number,
    raw: IncomingMessage["headers"],
    received: Buffer,
    ttfb: number,
    ms: number,
    here: string,
  ) => {
    const headers: Record<string, string> = {};
    for (const name of KEEP) {
      const value = raw[name];
      if (typeof value === "string") headers[name] = value.replaceAll(upstream + "/", here);
    }
    const body = await rewrite(received, headers, upstream + "/", here);
    let sha: string | null = null;
    if (body.length) {
      sha = createHash("sha256").update(body).digest("hex");
      if (!seen.has(sha)) {
        seen.add(sha);
        // Whole or not at all: a body file is never written again once it exists.
        if (!existsSync(join(bodies, sha))) {
          await writeFile(join(bodies, `${sha}.tmp`), body);
          await rename(join(bodies, `${sha}.tmp`), join(bodies, sha));
        }
      }
    }
    const entry: Entry = { ...asked, status, headers, body: sha, ttfb, ms };
    appendFileSync(indexFile, JSON.stringify(entry) + "\n");
    stats.recorded++;
    return { headers, body };
  };
} else {
  if (!old) throw new Error(`${dir} has no recording (no meta.json)`);
  meta = old;
  const scale = Number(option("--latency") ?? 1);
  const groups = load();
  // Read for each response, from the page cache once warm: holding every body would grow this
  // process by the size of the recording, beside the managers it measures.
  const bodyOf = (sha: string | null) =>
    sha ? readFile(join(bodies, sha)) : Promise.resolve(Buffer.alloc(0));

  handle = async (req, res) => {
    const arrived = performance.now();
    const asked = requestOf(req);
    const group = pick(groups.get(`${asked.method} ${asked.url}`) ?? [], asked);
    if (!group) {
      stats.missed++;
      console.error(
        `registry: not recorded: ${asked.method} ${tagOf(asked)}${asked.url} (accept: ${asked.accept})`,
      );
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not recorded" }));
      return;
    }
    stats.served++;
    if (group.first.key !== asked.key) {
      stats.near++;
      console.error(`registry: near match: ${asked.key} as ${group.first.key}`);
    }
    try {
      let body: Buffer = await bodyOf(group.first.body);
      const headers = { ...group.first.headers };
      const coding = headers["content-encoding"];
      // Recorded for another client: send it plain rather than in an encoding this one refused.
      if (coding && !accepts(asked.encoding, coding)) {
        body = await decoders[coding]!(body);
        delete headers["content-encoding"];
      }
      await paced(
        res,
        group.first.status,
        headers,
        asked.method === "HEAD" ? Buffer.alloc(0) : body,
        arrived,
        group.ttfb * scale,
        group.ms * scale,
      );
    } catch (error) {
      fail(res, error as Error);
    }
  };
}

/** Points a JSON body's upstream urls here, in the encoding it came in. */
async function rewrite(
  body: Buffer,
  headers: Record<string, string>,
  from: string,
  to: string,
): Promise<Buffer> {
  if (!body.length || !/json/.test(headers["content-type"] ?? "")) return body;
  const coding = headers["content-encoding"];
  if (coding && !(decoders[coding] && encoders[coding])) {
    console.error(`registry: cannot rewrite a ${coding} body; its tarballs stay upstream`);
    return body;
  }
  const text = (coding ? await decoders[coding]!(body) : body).toString();
  if (!text.includes(from)) return body;
  const plain = Buffer.from(text.replaceAll(from, to));
  return coding ? encoders[coding]!(plain) : plain;
}

interface Group {
  first: Entry;
  ttfb: number;
  ms: number;
}

/** Recorded responses by `method url`, one group per request key, whose first body wins. The
 * timing and `age` are the median of every sample of that url by any manager, so every manager
 * waits the same for the same thing: per abbreviated or full document, but one for a tarball,
 * whatever its request said it would accept. */
function load(): Map<string, Group[]> {
  const samples = new Map<string, Entry[]>();
  const timings = new Map<string, Entry[]>();
  const push = (map: Map<string, Entry[]>, key: string, entry: Entry) => {
    const list = map.get(key);
    if (list) list.push(entry);
    else map.set(key, [entry]);
  };
  const timingKey = (e: Entry) =>
    `${e.method} ${e.url} ${e.status} ${/json/.test(e.headers["content-type"] ?? "") && e.accept.includes(CORGI)}`;
  for (const entry of entries()) {
    push(samples, entry.key, entry);
    push(timings, timingKey(entry), entry);
  }
  const groups = new Map<string, Group[]>();
  for (const [first] of samples.values()) {
    const all = timings.get(timingKey(first!))!;
    const ttfb = median(all.map((e) => e.ttfb));
    // The CDN's age differs by sample too, by minutes: pooled, so every manager has the same
    // freshness left for the same document.
    const ages = all.map((e) => Number(e.headers.age)).filter((age) => !Number.isNaN(age));
    const headers = ages.length
      ? { ...first!.headers, age: String(Math.round(median(ages))) }
      : first!.headers;
    const group = {
      first: { ...first!, headers },
      ttfb,
      ms: Math.max(ttfb, median(all.map((e) => e.ms))),
    };
    const id = `${first!.method} ${first!.url}`;
    groups.set(id, [...(groups.get(id) ?? []), group]);
  }
  return groups;
}

/** The same request if recorded, else the closest answer the live registry could have given,
 * the same manager's first: never a 304 to a request that cannot take one, never an
 * abbreviated document to a request for the full one. */
function pick(groups: Group[], asked: Asked): Group | undefined {
  const corgi = asked.accept.includes(CORGI);
  let best: Group | undefined;
  let bestScore = -1;
  for (const group of groups) {
    const e = group.first;
    if (e.key === asked.key) return group;
    if (e.status === 304 && !asked.conditional) continue;
    if (e.accept.includes(CORGI) && !corgi) continue;
    const score =
      (e.runner === asked.runner && e.version === asked.version ? 8 : 0) +
      (e.accept.includes(CORGI) === corgi ? 4 : 0) +
      (e.conditional === asked.conditional ? 2 : 0) +
      (e.encoding === asked.encoding ? 1 : 0);
    if (score > bestScore) [best, bestScore] = [group, score];
  }
  return best;
}

/** Lists what the runs recorded cleanly and drops what other versions of their runners did. */
function settle(runsFile: string) {
  const current = new Map<string, string>();
  const clean = new Map<string, boolean>();
  for (const line of readFileSync(runsFile, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line);
    // upm's version is its commit; one recording serves every build.
    const version = row.runner === "upm" ? "any" : row.version;
    current.set(row.runner, version);
    const key = `${row.fixture} ${row.runner} ${version}`;
    clean.set(key, (clean.get(key) ?? true) && row.ok);
  }
  const stale = (runner: string, version: string) =>
    current.has(runner) && current.get(runner) !== version;

  const listed = new Set(
    (existsSync(recordedFile) ? readFileSync(recordedFile, "utf8").split("\n") : []).filter(
      (line) => line && !stale(line.split(" ")[1]!, line.split(" ")[2]!),
    ),
  );
  for (const [key, ok] of clean) {
    if (ok) listed.add(key);
    else console.error(`registry: ${key} had failed runs, so it is not listed as recorded`);
  }
  writeFileSync(recordedFile, [...listed].sort().join("\n") + "\n");

  const lines = [...entries()];
  const kept = lines.filter((e) => !stale(e.runner, e.version));
  if (kept.length === lines.length) return;
  writeFileSync(indexFile + ".tmp", kept.map((e) => JSON.stringify(e) + "\n").join(""));
  renameSync(indexFile + ".tmp", indexFile);
  const used = new Set(kept.map((e) => e.body));
  let removed = 0;
  for (const sha of readdirSync(bodies)) {
    if (!used.has(sha)) {
      unlinkSync(join(bodies, sha));
      removed++;
    }
  }
  console.log(
    `registry: dropped ${lines.length - kept.length} responses and ${removed} bodies of older versions`,
  );
}

/** The index's entries. A line cut short by a recorder that died mid-write is skipped. */
function* entries(): Generator<Entry> {
  for (const line of readFileSync(indexFile, "utf8").split("\n")) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      console.error(`registry: skipping a broken index line: ${line.slice(0, 80)}`);
    }
  }
}

/** Headers after `ttfb` ms, then the body in chunks, the last one at `ms`. */
async function paced(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: Buffer,
  arrived: number,
  ttfb: number,
  ms: number,
) {
  // From the request's arrival, so reading the body counts toward the recorded wait.
  await sleep(arrived + ttfb - performance.now());
  res.writeHead(status, { ...headers, "content-length": body.length });
  // HTTP/2's response has no `destroyed`; both say `close`.
  let closed = false;
  res.once("close", () => (closed = true));
  const start = arrived + ttfb;
  const n = Math.max(1, Math.ceil(body.length / CHUNK));
  for (let i = 0; i < n && !closed; i++) {
    await sleep(start + ((ms - ttfb) * (i + 1)) / n - performance.now());
    if (!res.write(body.subarray(i * CHUNK, (i + 1) * CHUNK))) {
      // Both listeners go when either fires: a large body waits here many times.
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done).off("close", done);
          resolve();
        };
        res.on("drain", done).on("close", done);
      });
    }
  }
  res.end();
}

function accepts(header: string, coding: string): boolean {
  return header.split(",").some((part) => {
    const [name, ...params] = part.trim().split(";");
    return (name === coding || name === "*") && !params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p));
  });
}

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function sleep(ms: number) {
  return ms >= 1 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function fail(res: ServerResponse, error: Error) {
  console.error(`registry: ${error.message}`);
  if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
  res.end(res.headersSent ? undefined : JSON.stringify({ error: error.message }));
}

/** A CA for the managers to trust and a certificate it signed for this server. A self-signed
 * certificate alone would do for Node, but rustls refuses a CA certificate as a server's. */
function certificate(): { key: Buffer; cert: Buffer } {
  if (!existsSync(join(tls, "cert.pem"))) {
    mkdirSync(tls, { recursive: true });
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    const openssl = (...args: string[]) =>
      execFileSync("openssl", args, { cwd: tls, stdio: "pipe" });
    openssl(
      "req",
      "-x509",
      ...ec,
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "3650",
      "-subj",
      "/CN=upm bench registry CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    );
    openssl(
      "req",
      "-new",
      ...ec,
      "-keyout",
      "key.pem",
      "-out",
      "cert.csr",
      "-subj",
      "/CN=127.0.0.1",
    );
    writeFileSync(
      join(tls, "cert.ext"),
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n" +
        "extendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n",
    );
    openssl(
      "x509",
      "-req",
      "-in",
      "cert.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      "cert.pem",
      "-days",
      "825",
      "-extfile",
      "cert.ext",
    );
  }
  return { key: readFileSync(join(tls, "key.pem")), cert: readFileSync(join(tls, "cert.pem")) };
}

// Each manager's protocol, logged once: which ones take HTTP/2 when offered.
const protocols = new Set<string>();
const serve = (req: IncomingMessage, res: ServerResponse) => {
  const seen = `${TAG.exec(req.url ?? "")?.[1] ?? "untagged"} HTTP/${req.httpVersion}`;
  if (!protocols.has(seen)) {
    protocols.add(seen);
    console.error(`registry: ${seen}`);
  }
  void handle(req, res);
};

const server = meta.origin.startsWith("https:")
  ? createSecureServer({ ...certificate(), allowHTTP1: true }, (req, res) =>
      serve(req as unknown as IncomingMessage, res as unknown as ServerResponse),
    )
  : createServer({ keepAliveTimeout: 60_000, requestTimeout: 0 }, serve);
server.listen(Number(new URL(meta.origin).port), "127.0.0.1", () => {
  if (!old) writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
  console.log(`registry: ${mode} ${dir} on ${meta.origin}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    const { served, near, missed, recorded } = stats;
    console.log(
      mode === "record"
        ? `registry: recorded ${recorded} responses`
        : `registry: served ${served} (${near} by a near match), missed ${missed}`,
    );
    process.exit(missed ? 1 : 0);
  });
}
