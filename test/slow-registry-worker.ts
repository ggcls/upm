// A registry worker that says hello at once and holds every answer until a message on the
// `upm-test-slow` channel lets them go. Its hello carries `undated: "hello"`, so a test learns
// through the pool's `undated` when the pool has read it. Its manifests are marked deprecated
// "thread".
import { parentPort, workerData } from "node:worker_threads";
import { pickManifest } from "../src/pick.ts";
import { createRegistry } from "../src/registry.ts";
import type { Answer, Question } from "../src/registry-pool.ts";

const port = parentPort!;
const registry = createRegistry(workerData);
const gate = new BroadcastChannel("upm-test-slow");
const released = new Promise((done) => (gate.onmessage = done));
port.on("message", (q: Question) => {
  const name = q.op === "pick" ? q.spec.fetchName : q.name;
  const found =
    q.op === "pinned"
      ? registry.pinned(q.name, q.version)
      : q.op === "manifest"
        ? registry.manifest(q.name, q.version)
        : registry.view(name).then((view) => pickManifest(view, q.spec, q.options));
  found.then(
    async (found) => {
      if (found) found.deprecated = "thread";
      await released;
      port.postMessage({ id: q.id, found } satisfies Answer);
    },
    (error: { message?: string; code?: string; status?: number }) => {
      const { message, code, status } = error;
      port.postMessage({ id: q.id, failed: { message: String(message ?? error), code, status } });
    },
  );
});
port.postMessage({ id: -1, undated: "hello" } satisfies Answer);
