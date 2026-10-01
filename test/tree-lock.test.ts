import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDIT_HELD, holdTree, TREE_HELD } from "../src/tree-lock.ts";

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
    expect(await readFile(held(), "utf8")).toMatch(
      new RegExp(`^${process.pid} [0-9a-z]+( \\S+)?\n$`),
    );
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

  it("waits out a moment's refusal of the name, as Windows gives while it deletes the file", async () => {
    const fsp = process.getBuiltinModule("node:fs/promises");
    // Windows says EPERM for a file it is still deleting; EBUSY means the same everywhere.
    const code = process.platform === "win32" ? "EPERM" : "EBUSY";
    const refuse = () => Promise.reject(Object.assign(new Error(code), { code }));
    vi.spyOn(fsp, "writeFile").mockImplementationOnce(refuse).mockImplementationOnce(refuse);
    let told = 0;
    await (
      await holdTree(nm, () => told++)
    )();
    expect(told).toBe(0);
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

  it.skipIf(!["linux", "darwin", "win32"].includes(process.platform))(
    "takes over at once from a holder that died on this boot, in this pid namespace",
    async () => {
      const release = await holdTree(nm, () => {});
      const where = (await readFile(held(), "utf8")).trim().split(" ")[2];
      await release();
      expect(where).toMatch(
        process.platform === "linux" ? /^[0-9a-f-]{36}\/pid:\[\d+\]$/ : /^[^\s:]+:\d+$/,
      );
      await writeFile(held(), `${DEAD} x ${where}\n`); // fresh, but its pid is gone
      let told = 0;
      await (
        await holdTree(nm, () => told++)
      )();
      expect(told).toBe(0);
      // A live pid there is waited for, and one from another boot gets the old rules.
      for (const holder of [`${process.pid} x ${where}`, `${DEAD} x other/pid:[1]`]) {
        await writeFile(held(), `${holder}\n`);
        let taken = false;
        const pending = holdTree(nm, () => {}).then((release) => ((taken = true), release));
        await new Promise((done) => setTimeout(done, 100));
        expect(taken).toBe(false);
        await rm(held());
        await (
          await pending
        )();
      }
    },
  );

  it("tells a dead holder at once where there is no /proc, by host and boot second", async () => {
    const fs = process.getBuiltinModule("node:fs");
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((path: string, ...rest: never[]) => {
      if (String(path).startsWith("/proc/"))
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return readFileSync(path, ...rest);
    }) as typeof readFileSync);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    vi.resetModules();
    try {
      const { holdTree } = await import("../src/tree-lock.ts");
      const release = await holdTree(nm, () => {});
      const where = (await readFile(held(), "utf8")).trim().split(" ")[2];
      await release();
      expect(where).toMatch(/^[^\s:]+:\d+$/);
      const [host, boot] = where!.split(":");
      // Booted a second off: os.uptime() counts whole seconds.
      for (const at of [where, `${host}:${Number(boot) + 1}`]) {
        await writeFile(held(), `${DEAD} x ${at}\n`);
        let told = 0;
        await (
          await holdTree(nm, () => told++)
        )();
        expect(told).toBe(0);
      }
      // A live pid here, another boot or another host: waited for.
      const others = [where, `${host}:${Number(boot) + 60}`, `other:${boot}`];
      for (const [i, at] of others.entries()) {
        await writeFile(held(), `${i ? DEAD : process.pid} x ${at}\n`);
        let taken = false;
        const pending = holdTree(nm, () => {}).then((release) => ((taken = true), release));
        await new Promise((done) => setTimeout(done, 100));
        expect(taken).toBe(false);
        await rm(held());
        await (
          await pending
        )();
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.resetModules();
    }
  });

  it("takes an edit's file at once from an `add` that crashed holding it", async () => {
    const dir = join(nm, "..");
    const lock = new URL("../src/tree-lock.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { EDIT_HELD, holdTree } = await import(${JSON.stringify(lock)});
        await holdTree(${JSON.stringify(dir)}, () => {}, EDIT_HELD);
        console.log("held");
        setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise((done) => child.stdout.once("data", done));
    await new Promise((done) => {
      child.once("exit", done);
      child.kill("SIGKILL");
    });
    expect(await readdir(dir)).toContain(EDIT_HELD);
    let told = 0;
    const start = Date.now();
    await (
      await holdTree(dir, () => told++, EDIT_HELD)
    )();
    expect(told).toBe(0);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(await readdir(dir)).not.toContain(EDIT_HELD);
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

  it("lets only one of three waiters that judged the same dead file at once hold it", async () => {
    // Each waiter runs in its own async context, so the spies below can tell them apart.
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const who = new AsyncLocalStorage<number>();
    const fsp = process.getBuiltinModule("node:fs/promises");
    const { readFile, rename, unlink, writeFile } = fsp;
    await aged(DEAD, 11);
    const dead = await readFile(held(), "utf8");
    let judged = 0;
    const turn = [0, 1, 2].map(() => Promise.withResolvers<void>());
    // Each waiter stops once it has read the dead file, until all three have.
    vi.spyOn(fsp, "readFile").mockImplementation((async (...args: Parameters<typeof readFile>) => {
      const text = await readFile(...args);
      const i = who.getStore();
      if (i !== undefined && args[0] === held() && text === dead && judged < 3) {
        judged++;
        await turn[i]!.promise;
      }
      return text;
    }) as typeof readFile);
    // The second waiter stops again just after its first change to the tree.
    let paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let pausing = false;
    const pauseAfter = <F extends (...args: never[]) => Promise<unknown>>(real: F) =>
      (async (...args: Parameters<F>) => {
        try {
          return await real(...args);
        } finally {
          if (pausing && who.getStore() === 1) {
            pausing = false;
            paused.resolve();
            await resume.promise;
          }
        }
      }) as F;
    vi.spyOn(fsp, "writeFile").mockImplementation(pauseAfter(writeFile));
    vi.spyOn(fsp, "rename").mockImplementation(pauseAfter(rename));
    vi.spyOn(fsp, "unlink").mockImplementation(pauseAfter(unlink));

    const releases: (() => Promise<void>)[] = [];
    const settled = [0, 1, 2].map(() => Promise.withResolvers<void>());
    const waiters = [0, 1, 2].map((i) =>
      who.run(i, () =>
        holdTree(nm, () => settled[i]!.resolve()).then((release) => {
          releases.push(release);
          settled[i]!.resolve();
          return release;
        }),
      ),
    );
    await vi.waitFor(() => expect(judged).toBe(3), { timeout: 5000 });
    turn[0]!.resolve();
    await settled[0]!.promise;
    expect(releases).toHaveLength(1);
    pausing = true;
    turn[1]!.resolve();
    await Promise.race([paused.promise, settled[1]!.promise]);
    turn[2]!.resolve();
    await settled[2]!.promise;
    resume.resolve();
    await settled[1]!.promise;
    await new Promise((done) => setTimeout(done, 100));
    expect(releases).toHaveLength(1);
    // Let go, the other two take it in turn.
    await releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 5000 });
    await new Promise((done) => setTimeout(done, 100));
    expect(releases).toHaveLength(2);
    await releases[1]!();
    await Promise.all(waiters);
    await releases[2]!();
    expect(await readdir(nm)).toEqual([]);
  });

  it("takes the turn of a waiter that died while it took over, and waits for a live one", async () => {
    await aged(DEAD, 11);
    const taking = `${held()}.taking`;
    await writeFile(taking, `${process.pid} x\n`);
    let taken = false;
    const pending = holdTree(nm, () => {}).then((release) => ((taken = true), release));
    await new Promise((done) => setTimeout(done, 100));
    expect(taken).toBe(false);
    const then = new Date(Date.now() - 11_000);
    await writeFile(taking, `${DEAD} x\n`);
    await utimes(taking, then, then);
    await (
      await pending
    )();
    expect(await readdir(nm)).toEqual([]);
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

  /**
   * A process holding the file, after `before` has run, then ended by `signal`: sent, or raised
   * in it as Node does for a signal it gets. Windows can send no signal but a forced end.
   */
  async function holder(before = "", signal: NodeJS.Signals = "SIGINT", raised = false) {
    const lock = new URL("../src/tree-lock.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { holdTree } = await import(${JSON.stringify(lock)});
        ${before}
        await holdTree(${JSON.stringify(nm)}, () => {});
        process.stdin.on("data", () => process.emit(${JSON.stringify(signal)}, ${JSON.stringify(signal)}));
        console.log("held");
        setInterval(() => {}, 1000);`,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let out = "";
    await new Promise((done) =>
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.includes("held")) done(undefined);
      }),
    );
    expect(await readdir(nm)).toEqual([TREE_HELD]);
    const end = await new Promise<[number | null, string | null]>((done) => {
      child.once("exit", (...end) => done(end));
      if (raised) child.stdin.write("\n");
      else child.kill(signal);
    });
    return { end, out };
  }

  it.skipIf(process.platform === "win32")(
    "gives the file up when a signal ends the process, and dies of it",
    async () => {
      expect((await holder()).end).toEqual([null, "SIGINT"]);
      expect(await readdir(nm)).toEqual([]);
    },
  );

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "gives the file up when %s ends the process, where it cannot be sent too",
    async (signal) => {
      const { end } = await holder("", signal, true);
      expect(await readdir(nm)).toEqual([]);
      if (process.platform !== "win32") expect(end).toEqual([null, signal]);
      // Windows ends a process for SIGINT and SIGTERM, and cannot raise SIGHUP: 128 + its number.
      else if (signal === "SIGHUP") expect(end).toEqual([129, null]);
      else expect(end).toEqual([1, null]);
    },
  );

  it("exits with 128 and the signal's number where it cannot raise the signal again", async () => {
    // As Windows refuses to raise SIGHUP, so this runs everywhere.
    const { end } = await holder(
      `const kill = process.kill.bind(process);
      process.kill = (pid, signal) => {
        if (signal !== "SIGHUP") return kill(pid, signal);
        throw Object.assign(new Error("kill ENOSYS"), { code: "ENOSYS" });
      };`,
      "SIGHUP",
      true,
    );
    expect(end).toEqual([129, null]);
    expect(await readdir(nm)).toEqual([]);
  });

  it("leaves a signal someone else listens for to them, and gives the file up on exit", async () => {
    const { end, out } = await holder(
      `const { existsSync } = await import("node:fs");
      process.on("SIGINT", () => {
        console.log(existsSync(${JSON.stringify(held())}) ? "kept" : "lost");
        process.exit(7);
      });`,
      "SIGINT",
      process.platform === "win32",
    );
    expect(end).toEqual([7, null]);
    expect(out).toContain("kept");
    expect(await readdir(nm)).toEqual([]);
  });

  it("listens once however many trees it holds, and not at all once they are let go", async () => {
    const events = ["SIGINT", "SIGTERM", "SIGHUP", "exit"] as const;
    const count = () => events.map((event) => process.listenerCount(event));
    const before = count();
    const releases = await Promise.all(
      Array.from({ length: 12 }, (_, i) => holdTree(join(nm, `${i}`), () => {})),
    );
    expect(count()).toEqual(before.map((n) => n + 1));
    for (const release of releases) await release();
    expect(count()).toEqual(before);
  });

  it("holds and gives up the file under a `process` with no events, as the web shim's", async () => {
    vi.stubGlobal("process", { getBuiltinModule: process.getBuiltinModule.bind(process) });
    try {
      const release = await holdTree(nm, () => {});
      await release();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await readdir(nm)).toEqual([]);
  });

  it("leaves a file it no longer holds to the process that took it over", async () => {
    const release = await holdTree(nm, () => {});
    await rm(held());
    await writeFile(held(), "123\n");
    await release();
    expect(await readFile(held(), "utf8")).toBe("123\n");
  });
});
