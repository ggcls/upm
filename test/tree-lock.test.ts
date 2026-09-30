import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdTree, TREE_HELD } from "../src/tree-lock.ts";

let nm: string;
const held = () => join(nm, TREE_HELD);
/** A pid no process has here: past the kernel's default `pid_max`. */
const DEAD = 4_194_305;

beforeEach(async () => {
  nm = join(await mkdtemp(join(tmpdir(), "upm-tree-lock-")), "node_modules");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(join(nm, ".."), { recursive: true, force: true });
});

async function aged(pid: number, seconds: number): Promise<void> {
  await holdTree(nm, () => {}).then((release) => release());
  await writeFile(held(), `${pid}\n`);
  const then = new Date(Date.now() - seconds * 1000);
  await utimes(held(), then, then);
}

describe("holdTree", () => {
  it("makes node_modules, holds the file with its pid and gives it up", async () => {
    const release = await holdTree(nm, () => {});
    expect(await readFile(held(), "utf8")).toMatch(new RegExp(`^${process.pid} [0-9a-z]+\n$`));
    await release();
    expect(await readdir(nm)).toEqual([]);
  });

  it("waits for a live holder, saying so once, and takes the file when it is let go", async () => {
    const first = await holdTree(nm, () => {});
    let told = 0;
    let taken = false;
    const second = holdTree(nm, () => told++).then((release) => {
      taken = true;
      return release;
    });
    await new Promise((done) => setTimeout(done, 200));
    expect(taken).toBe(false);
    expect(told).toBe(1);
    await first();
    await (
      await second
    )();
    expect(told).toBe(1);
    expect(await readdir(nm)).toEqual([]);
  });

  it("takes over from a holder that died, and one gone quiet in another pid namespace", async () => {
    await aged(DEAD, 11);
    let told = 0;
    await (
      await holdTree(nm, () => told++)
    )();
    // A pid that is alive here, but untouched for a minute: not the holder, whoever it is.
    await aged(process.pid, 61);
    await (
      await holdTree(nm, () => told++)
    )();
    expect(told).toBe(0);
  });

  it("lets one of two waiters take a dead holder's file, and the other wait for it", async () => {
    await aged(DEAD, 11);
    const held: (() => Promise<void>)[] = [];
    const both = [0, 1].map(() => holdTree(nm, () => {}).then((release) => held.push(release)));
    await vi.waitFor(() => expect(held).toHaveLength(1), { timeout: 5000 });
    await new Promise((done) => setTimeout(done, 200));
    expect(held).toHaveLength(1);
    await held[0]!();
    await Promise.all(both);
    expect(held).toHaveLength(2);
    await held[1]!();
    expect(await readdir(nm)).toEqual([]);
  });

  it("puts back the file of a holder that took over between its look and its move", async () => {
    await aged(DEAD, 11);
    const fsp = process.getBuiltinModule("node:fs/promises");
    const rename = fsp.rename;
    const live = `${process.pid} other\n`;
    let moved = false;
    // The other waiter's turn, just after this one judged the dead file.
    vi.spyOn(fsp, "rename").mockImplementationOnce(async (from, to) => {
      await rm(held());
      await writeFile(held(), live);
      await rename(from, to);
      moved = true;
    });
    let taken = false;
    const pending = holdTree(nm, () => {}).then((release) => ((taken = true), release));
    await vi.waitFor(() => expect(moved).toBe(true), { timeout: 5000 });
    // Put back, and the aside file gone.
    await vi.waitFor(async () => expect(await readdir(nm)).toEqual([TREE_HELD]), { timeout: 5000 });
    await new Promise((done) => setTimeout(done, 100));
    expect(taken).toBe(false);
    expect(await readFile(held(), "utf8")).toBe(live);
    await rm(held());
    await (
      await pending
    )();
  });

  // Windows ignores a directory's read-only bit, and root ignores it everywhere.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails with ESTATE when the tree cannot be written",
    async () => {
      await mkdir(nm);
      await chmod(nm, 0o555);
      try {
        await expect(holdTree(nm, () => {})).rejects.toMatchObject({ code: "ESTATE" });
      } finally {
        await chmod(nm, 0o755);
      }
    },
  );

  it("waits for a live pid, or any holder touched lately", async () => {
    await aged(process.pid, 30);
    let taken = false;
    const pending = holdTree(nm, () => {}).then((release) => ((taken = true), release));
    await new Promise((done) => setTimeout(done, 100));
    expect(taken).toBe(false);
    await rm(held());
    await (
      await pending
    )();

    await aged(DEAD, 1); // just written by a holder that has not beat yet
    taken = false;
    const next = holdTree(nm, () => {}).then((release) => ((taken = true), release));
    await new Promise((done) => setTimeout(done, 100));
    expect(taken).toBe(false);
    await rm(held());
    await (
      await next
    )();
  });

  it("leaves a file it no longer holds to the process that took it over", async () => {
    const release = await holdTree(nm, () => {});
    await rm(held());
    await writeFile(held(), "123\n");
    await release();
    expect(await readFile(held(), "utf8")).toBe("123\n");
  });
});
