#!/usr/bin/env bash
# profile.sh [-n <runs>] [-f <fixture>] [--warm|--cold]
#
# Builds dist/ once, then times these commands in rounds and prints the median wall time,
# peak memory and CPU of each:
#
#   node                an empty .mjs file: what Node itself costs to start and exit
#   upm --version       this tree's dist/
#   upm@<v> --version   the published upm, as unpacked from its tarball
#   pnpm@<v> --version  pnpm 12's native binary (@pnpm/exe.<platform>), as unpacked
#   upm i               an install in a copy of a bench fixture, with a private store
#
# Then it times getting each package manager: `curl` downloads the published upm tarball and
# pnpm 12's native binary package from registry.npmjs.org, and `tar` unpacks each into an
# empty directory, with no Node involved.
#
# Needs only bash, Node, curl and tar, no Perl or /usr/bin/time, so it runs in bare CI images.
# - Wall time is taken in the harness around spawn and reap, to the microsecond.
# - For Node, memory and CPU are the child's own getrusage (`process.resourceUsage()`),
#   written by a `--require` hook when the process exits. It covers every thread, workers
#   included; RSS is the process's peak. Every Node command pays the hook's ~1 ms, so it
#   cancels in `+node`.
# - pnpm's binary is not Node, so its peak RSS (`~`) is sampled from /proc in separate runs.
#
#   -n <runs>     timed runs per command (default 20), after one untimed warm-up each
#   -f <fixture>  a name in bench/fixtures, or a project path with a `/` (default tiny)
#   --warm        remove node_modules before each install (default repeat: nothing removed)
#   --cold        also remove upm.lock and the store before each install (uses the registry)
#
# BENCH_WORK moves the work directory, as with bench.sh.
set -eu
BENCH=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$BENCH")
RUNS=20 FIXTURE=tiny MODE=repeat
while [ $# -gt 0 ]; do
  case $1 in
    -n) RUNS=$2; shift ;;
    -f) FIXTURE=$2; shift ;;
    --warm) MODE=warm ;;
    --cold) MODE=cold ;;
    *) sed -n 2,30p "$0"; exit 2 ;;
  esac
  shift
done
case $FIXTURE in */*) SRC=$(cd "$FIXTURE" && pwd) ;; *) SRC=$BENCH/fixtures/$FIXTURE ;; esac
[ -f "$SRC/package.json" ] || { echo "profile: no fixture $FIXTURE"; exit 2; }

WORK=${BENCH_WORK:-${XDG_CACHE_HOME:-$HOME/.cache}/upm-bench}/profile-$$
mkdir -p "$WORK/project" "$WORK/store"
trap 'rm -rf "$WORK"' EXIT

echo "profile: building dist/..."
( cd "$ROOT" && node ./upm run build ) >"$WORK/build.log" 2>&1 || { cat "$WORK/build.log"; exit 1; }

tar -C "$SRC" --exclude=node_modules --exclude=upm.lock -cf - . | tar -C "$WORK/project" -xf -
: >"$WORK/empty.mjs"
# Workers inherit --require but copy env when they start, so only the main thread sees the path.
# Checking `worker_threads` instead would cost 2 ms per start; this costs about 1 ms.
cat >"$WORK/hook.cjs" <<'JS'
const out = process.env.PROFILE_USAGE;
delete process.env.PROFILE_USAGE;
if (out) process.on("exit", () => require("node:fs").writeFileSync(out, JSON.stringify(process.resourceUsage())));
JS

echo "profile: $(node --version), $RUNS runs, upm i: $(basename "$SRC") $MODE"
DIST=$ROOT/dist RUNS=$RUNS MODE=$MODE WORK=$WORK FIXTURE=$(basename "$SRC") node --input-type=module - <<'JS'
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";

const { DIST, RUNS, MODE, WORK, FIXTURE } = process.env;
const env = { ...process.env, PROFILE_USAGE: `${WORK}/usage.json` };
const project = `${WORK}/project`;

// Milliseconds from spawn to reap. Exits the harness if the command fails.
function timed(cmd, args, opts) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, opts);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) {
    console.error(`profile: ${[cmd, ...args].join(" ")} failed (${r.status ?? r.signal})\n${r.stdout}${r.stderr}`);
    process.exit(1);
  }
  return ms;
}

// Each round starts one item later, so a slow moment does not always land on the same one.
// One untimed run each goes first: it fills caches, the store and upm.lock.
function rounds(items, fn) {
  for (const item of items) fn(item);
  const samples = items.map(() => []);
  for (let i = 0; i < Number(RUNS); i++) {
    for (let j = 0; j < items.length; j++) {
      const k = (i + j) % items.length;
      samples[k].push(fn(items[k]));
    }
  }
  return samples;
}

const median = (list, key) => {
  const a = list.map((s) => s[key]).sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const f = (v) => (Number.isFinite(v) ? v.toFixed(2) : "");

function print(table) {
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  for (const row of table) console.log(row.map((cell, c) => (c ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join("  "));
}

// The package managers as published: upm's tarball, and pnpm 12's native binary for this host.
const libc = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime ? "-musl" : "";
const registry = async (path) => (await fetch(`https://registry.npmjs.org/${path}`)).json();
const pnpm = await registry("pnpm/latest-12");
const managers = [];
for (const [spec, bin] of [["upm/latest", "dist/upm.mjs"], [`@pnpm/exe.${process.platform}-${process.arch}${libc}/${pnpm.version}`, "pnpm"]]) {
  const { name, version, dist } = await registry(spec);
  const dir = `${WORK}/${name.replace("/", "+")}`;
  managers.push({ name: `${name}@${version}`, url: dist.tarball, files: dist.fileCount, file: `${dir}.tgz`, bin: `${dir}/package/${bin}` });
}
const unpackDir = `${WORK}/unpack`;
function get(m, to = unpackDir) {
  rmSync(m.file, { force: true });
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to);
  const fetchMs = timed("curl", ["-fsSL", "-o", m.file, m.url]);
  return { fetch: fetchMs, unpack: timed("tar", ["-xzf", m.file, "-C", to]) };
}
// Unpacked once to run below, untimed.
for (const m of managers) get(m, m.bin.slice(0, m.bin.indexOf("/package/")));

const reset = () => {
  if (MODE === "repeat") return;
  // A workspace has a node_modules of its own.
  spawnSync("find", [project, "-name", "node_modules", "-prune", "-exec", "rm", "-rf", "{}", "+"]);
  if (MODE === "cold") {
    rmSync(`${project}/upm.lock`, { force: true });
    rmSync(`${WORK}/store`, { recursive: true, force: true });
  }
};
const [upm, pnpmExe] = managers;
const commands = [
  { name: "node", args: [`${WORK}/empty.mjs`] },
  { name: "upm --version", args: [`${DIST}/upm.mjs`, "--version"] },
  { name: `${upm.name} --version`, args: [upm.bin, "--version"] },
  { name: `pnpm@${pnpm.version} --version`, native: [pnpmExe.bin, "--version"] },
  { name: `upm i (${FIXTURE}, ${MODE})`, args: [`${DIST}/upm.mjs`, "i", "--store", `${WORK}/store`], cwd: project, reset },
];

function run(c) {
  c.reset?.();
  const cwd = c.cwd ?? WORK;
  if (c.native) return { ms: timed(c.native[0], c.native.slice(1), { cwd }) };
  rmSync(env.PROFILE_USAGE, { force: true });
  const ms = timed(process.execPath, ["--require", `${WORK}/hook.cjs`, ...c.args], { cwd, env });
  const u = JSON.parse(readFileSync(env.PROFILE_USAGE, "utf8"));
  return { ms, rss: u.maxRSS / 1024, cpu: (u.userCPUTime + u.systemCPUTime) / 1000 };
}

// Peak RSS of a program the hook cannot load into: VmHWM from /proc every 0.1 ms until the
// process turns zombie. The loop is synchronous, so Node cannot reap it before that. Samples
// named like this process are the fork before exec, which still holds the harness's memory.
const tick = new Int32Array(new SharedArrayBuffer(4));
const self = /^Name:\s+(.*)$/m.exec(readFileSync("/proc/self/status", "utf8"))[1];
async function sampledRss([cmd, ...args]) {
  const child = spawn(cmd, args, { cwd: WORK, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let peak = 0;
  for (;;) {
    let status;
    try {
      status = readFileSync(`/proc/${child.pid}/status`, "utf8");
    } catch {
      break;
    }
    const hwm = /^VmHWM:\s+(\d+)/m.exec(status);
    if (!hwm) break;
    if (/^Name:\s+(.*)$/m.exec(status)[1] !== self) peak = Math.max(peak, Number(hwm[1]));
    Atomics.wait(tick, 0, 0, 0.1);
  }
  await exited;
  return { rss: peak / 1024 };
}

const samples = rounds(commands, run);
for (const [i, c] of commands.entries()) {
  if (!c.native) continue;
  for (let k = 0; k < Math.min(Number(RUNS), 10); k++) samples[i][k].rss = (await sampledRss(c.native)).rss;
}
const rows = samples.map((list, i) => {
  const list2 = list.filter((s) => s.rss !== undefined);
  return { ms: median(list, "ms"), rss: list2.length ? median(list2, "rss") : NaN, cpu: commands[i].native ? NaN : median(list, "cpu") };
});
const node = rows[0];
print([
  ["command", "ms", "+node ms", "rss MB", "+node MB", "cpu ms"],
  ...rows.map((r, i) => {
    const { native } = commands[i];
    const plus = (v) => (i && !native ? f(v) : "");
    return [commands[i].name, f(r.ms), plus(r.ms - node.ms), (native ? "~" : "") + f(r.rss), plus(r.rss - node.rss), f(r.cpu)];
  }),
]);

// Getting each manager: its tarball fetched by curl on a new connection each time, and
// unpacked by tar into an empty directory.
const got = rounds(managers, (m) => get(m));
console.log();
print([
  ["package", "tgz KB", "files", "fetch ms", "unpack ms", "total ms"],
  ...got.map((list, i) => [
    managers[i].name, (statSync(managers[i].file).size / 1024).toFixed(0), String(managers[i].files),
    f(median(list, "fetch")), f(median(list, "unpack")), f(median(list.map((s) => ({ t: s.fetch + s.unpack })), "t")),
  ]),
]);
JS
