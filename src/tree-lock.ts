// One install at a time rewrites a tree: two at once would each link its own tops and leave
// them mixed. Loaded only once the tree must change, so a no-op install never reads this.
import { builtin } from "./builtin.ts";
import { pid, sleep } from "./runtime.ts";
import { alive } from "./util.ts";

export const TREE_HELD = ".upm.linking";

/** How often the holder touches the file, so a waiter can tell it from a dead one. */
const BEAT = 2000;
/** Untouched this long and its pid gone here, the holder died. */
const STALE = 10_000;
/**
 * Untouched this long, the holder died whatever its pid says: a pid from another namespace
 * sharing the tree through a mount can name a live process here, or none.
 */
const ABANDONED = 60_000;

/**
 * Take `<nm>/.upm.linking`, waiting while another process holds it. `waiting` is told once,
 * when there is a wait. Resolves to the release, which gives the file up only while it is
 * still the one this call made. The file holds the pid and a token: a freed inode is reused
 * at once, so only the token tells one holder's file from the next.
 */
export async function holdTree(nm: string, waiting: () => void): Promise<() => Promise<void>> {
  const { mkdir, readFile, unlink, utimes, writeFile } = builtin.fsp;
  const path = builtin.path.join(nm, TREE_HELD);
  const mine = `${pid} ${token()}\n`;
  await mkdir(nm, { recursive: true }).catch((error: unknown) => {
    throw cannot(path, error);
  });
  let delay = 25;
  let told = false;
  for (;;) {
    try {
      await writeFile(path, mine, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw cannot(path, error);
    }
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
  return async () => {
    clearInterval(beat);
    if ((await readFile(path, "utf8").catch(() => "")) === mine) await unlink(path).catch(() => {});
  };
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
    if (age < STALE) return false;
    judged = await readFile(path, "utf8");
  } catch (error) {
    return gone(path, error);
  }
  const holder = Number.parseInt(judged, 10);
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
  if (code === "EBUSY" || code === "EPERM") return false;
  throw cannot(path, error);
}

/** As the state file's own failures: the tree cannot be written. */
function cannot(path: string, error: unknown): Error {
  const reason = (error as Error).message;
  return Object.assign(new Error(`cannot hold ${path}: ${reason}`), { code: "ESTATE" });
}
