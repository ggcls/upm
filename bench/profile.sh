#!/usr/bin/env bash
# profile.sh [-n <runs>] [-f <fixture>] [--warm|--cold]
#
# Builds dist/ once, then times three commands in rounds and prints wall time, peak memory
# and CPU for each:
#
#   node           an empty .mjs file: what Node itself costs to start and exit
#   upm --version  Node plus loading upm's CLI
#   upm i          an install in a copy of a bench fixture, with a private store
#
# Needs only bash and Node, no Perl or /usr/bin/time, so it runs in bare CI images.
# - Wall time is taken in the harness around spawn and reap, to the microsecond.
# - Memory and CPU are the child's own getrusage (`process.resourceUsage()`), written by a
#   `--require` hook when the process exits. It covers every thread, workers included; RSS
#   is the process's peak. Every command pays the hook's ~1 ms, so it cancels in `+node`.
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
    *) sed -n 2,22p "$0"; exit 2 ;;
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
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const { DIST, RUNS, MODE, WORK, FIXTURE } = process.env;
const env = { ...process.env, PROFILE_USAGE: `${WORK}/usage.json` };
const upm = `${DIST}/upm.mjs`;
const project = `${WORK}/project`;
const reset = () => {
  if (MODE === "repeat") return;
  // A workspace has a node_modules of its own.
  spawnSync("find", [project, "-name", "node_modules", "-prune", "-exec", "rm", "-rf", "{}", "+"]);
  if (MODE === "cold") {
    rmSync(`${project}/upm.lock`, { force: true });
    rmSync(`${WORK}/store`, { recursive: true, force: true });
  }
};
const commands = [
  { name: "node", args: [`${WORK}/empty.mjs`] },
  { name: "upm --version", args: [upm, "--version"] },
  { name: `upm i (${FIXTURE}, ${MODE})`, args: [upm, "i", "--store", `${WORK}/store`], cwd: project, reset },
];

function run(c) {
  c.reset?.();
  rmSync(env.PROFILE_USAGE, { force: true });
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, ["--require", `${WORK}/hook.cjs`, ...c.args], { cwd: c.cwd, env });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) {
    console.error(`profile: ${c.name} failed (${r.status ?? r.signal})\n${r.stdout}${r.stderr}`);
    process.exit(1);
  }
  const u = JSON.parse(readFileSync(env.PROFILE_USAGE, "utf8"));
  return { ms, rss: u.maxRSS / 1024, cpu: (u.userCPUTime + u.systemCPUTime) / 1000 };
}

// One untimed run each: fills the compile cache, the store and upm.lock.
for (const c of commands) run(c);
const samples = commands.map(() => []);
// Each round starts one command later, so a slow moment does not always land on the same one.
for (let i = 0; i < Number(RUNS); i++) {
  for (let j = 0; j < commands.length; j++) {
    const k = (i + j) % commands.length;
    samples[k].push(run(commands[k]));
  }
}

const sorted = (list, key) => list.map((s) => s[key]).sort((a, b) => a - b);
const median = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
const rows = samples.map((list) => {
  const ms = sorted(list, "ms"), rss = sorted(list, "rss"), cpu = sorted(list, "cpu");
  return { ms, med: median(ms), rss: median(rss), rssMax: rss.at(-1), cpu: median(cpu) };
});
const f = (v) => v.toFixed(2);
const table = [
  ["command", "min ms", "median ms", "max ms", "+node ms", "rss MB", "max rss MB", "+node MB", "cpu ms"],
  ...rows.map((r, i) => [
    commands[i].name, f(r.ms[0]), f(r.med), f(r.ms.at(-1)), i ? f(r.med - rows[0].med) : "",
    f(r.rss), f(r.rssMax), i ? f(r.rss - rows[0].rss) : "", f(r.cpu),
  ]),
];
const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
for (const row of table) console.log(row.map((cell, c) => (c ? cell.padStart(widths[c]) : cell.padEnd(widths[c]))).join("  "));
JS
