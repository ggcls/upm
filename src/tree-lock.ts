// One install at a time rewrites a tree: two at once would each link its own tops and leave
// them mixed. Loaded only once the tree must change, so a no-op install never reads this.
import { builtin } from "./builtin.ts";
import { pid, sleep } from "./runtime.ts";
import { alive } from "./util.ts";

export const TREE_HELD = ".upm.linking";

/** How often the holder touches the file, so a waiter can tell it from a dead one. */
const BEAT = 2000;
/** Untouched this long and its pid gone here, the holder died. At once when `here()` says so. */
const STALE = 10_000;
/**
 * Untouched this long, the holder died whatever its pid says: a pid from another namespace
 * sharing the tree through a mount can name a live process here, or none.
 */
const ABANDONED = 60_000;

/** What `add` and `remove` hold beside a package.json from their check of it to their write. */
export const EDIT_HELD = ".upm.editing";

/**
 * Take `<nm>/.upm.linking` (or `name`), waiting while another process holds it. `waiting` is
 * told once, when there is a wait. Resolves to the release, which gives the file up only while
 * it is still the one this call made. The file holds the pid and a token: a freed inode is
 * reused at once, so only the token tells one holder's file from the next. On Linux it also
 * names where the pid means something, so a waiter there need not wait out STALE for a dead one.
 */
export async function holdTree(
  nm: string,
  waiting: () => void,
  name = TREE_HELD,
): Promise<() => Promise<void>> {
  const { mkdir, readFile, unlink, utimes, writeFile } = builtin.fsp;
  const path = builtin.path.join(nm, name);
  const mine = `${[pid, token(), here()].join(" ").trimEnd()}\n`;
  await mkdir(nm, { recursive: true }).catch((error: unknown) => {
    throw cannot(path, error);
  });
  let delay = 25;
  let told = false;
  let busySince = 0;
  for (;;) {
    try {
      await writeFile(path, mine, { flag: "wx" });
      break;
    } catch (error) {
      const { code } = error as { code?: string };
      if (busy(code)) {
        // Windows refuses the name while the last holder's file is still being deleted.
        busySince ||= Date.now();
        if (Date.now() - busySince > STALE) throw cannot(path, error);
        await sleep(25);
        continue;
      }
      if (code !== "EEXIST") throw cannot(path, error);
    }
    busySince = 0;
    if (await takeOver(path)) continue;
    if (!told) waiting();
    told = true;
    await sleep(delay);
    delay = Math.min(delay * 2, 500);
  }
  const beat = setInterval(() => {
    const now = new Date();
    utimes(path, now, now).catch(() => {});
  }, BEAT);
  beat.unref?.();
  const file = { path, mine };
  holding(file, true);
  return async () => {
    clearInterval(beat);
    holding(file, false);
    if ((await readFile(path, "utf8").catch(() => "")) === mine) await unlink(path).catch(() => {});
  };
}

/** What a terminal, a CI timeout or `docker stop` ends an install with. */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** The files this process holds, all under one listener per event however many there are. */
const held = new Set<{ path: string; mine: string }>();

function holding(file: { path: string; mine: string }, on: boolean): void {
  const was = held.size > 0;
  if (on) held.add(file);
  else held.delete(file);
  if (was !== held.size > 0) listen(on);
}

function listen(on: boolean): void {
  const proc = globalThis.process;
  if (typeof proc?.on !== "function") return; // no signals to end it, off Node
  for (const signal of SIGNALS) proc[on ? "on" : "off"](signal, dying);
  proc[on ? "on" : "off"]("exit", giveUp);
}

/**
 * A signal ends the process without `finally`, and the next install would wait out STALE: give
 * the files up and die of the signal as before. When someone else listens for it, they decide
 * whether the process ends, and the files stay held until the install lets go or it exits.
 */
function dying(signal: NodeJS.Signals): void {
  const proc = globalThis.process;
  if (proc.listenerCount(signal) > 1) return;
  giveUp();
  try {
    proc.kill(pid, signal);
  } catch {
    proc.exit(128 + (builtin.os.constants.signals[signal] ?? 0)); // Windows cannot send SIGHUP
  }
}

function giveUp(): void {
  for (const { path, mine } of held) {
    try {
      if (builtin.fs.readFileSync(path, "utf8") === mine) builtin.fs.unlinkSync(path);
    } catch {}
  }
  held.clear();
  listen(false);
}

/** Unique enough to tell two holders apart, and no crypto to load on a link that builds nothing. */
function token(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/** True when the file is gone or was a dead holder's and is now out of the way. */
async function takeOver(path: string): Promise<boolean> {
  const { readFile, rename, stat, unlink, writeFile } = builtin.fsp;
  let age: number;
  let judged: string;
  try {
    age = Date.now() - (await stat(path)).mtimeMs;
    judged = await readFile(path, "utf8");
  } catch (error) {
    return gone(path, error);
  }
  const [first = "", , where] = judged.trim().split(" ");
  const holder = Number.parseInt(first, 10);
  // Made on this boot and in this pid namespace, a pid that is gone is a holder that died.
  const local = where !== undefined && where === here();
  if (!local && age < STALE) return false;
  if (age < ABANDONED && holder > 0 && alive(holder)) return false;
  // Moved aside rather than removed: a second waiter that judged the same dead file must not
  // remove the one the first just made. If what moved was not what we judged, put it back.
  const aside = `${path}.${pid}-${token()}`;
  try {
    await rename(path, aside);
  } catch (error) {
    return gone(path, error); // someone else moved it first
  }
  const moved = await readFile(aside, "utf8").catch(() => judged);
  if (moved !== judged) await writeFile(path, moved, { flag: "wx" }).catch(() => {});
  await unlink(aside).catch(() => {});
  return true;
}

/**
 * The file went away while we looked: take it. Windows may refuse a file another process has
 * open for a moment: wait. Anything else would fail every retry, so it fails the install.
 */
function gone(path: string, error: unknown): boolean {
  const { code } = error as { code?: string };
  if (code === "ENOENT") return true;
  if (code === "EPERM" || busy(code)) return false;
  throw cannot(path, error);
}

const WIN = globalThis.process?.platform === "win32";

/**
 * A moment's refusal, not a tree that cannot be written. Windows says EPERM or EACCES for a
 * file another process is deleting or has open; elsewhere those mean no permission.
 */
function busy(code: string | undefined): boolean {
  return code === "EBUSY" || (WIN && (code === "EPERM" || code === "EACCES"));
}

/** As the state file's own failures: the tree cannot be written. */
function cannot(path: string, error: unknown): Error {
  const reason = (error as Error).message;
  return Object.assign(new Error(`cannot hold ${path}: ${reason}`), { code: "ESTATE" });
}

let place: string | undefined;

/**
 * This boot of this machine and this pid namespace, where Linux names them, else "". Two hosts
 * sharing a tree over NFS have the same root namespace, so the boot id tells them apart.
 */
function here(): string {
  if (place !== undefined) return place;
  try {
    const { readFileSync, readlinkSync } = builtin.fs;
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    place = `${boot}/${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    place = "";
  }
  return place;
}
