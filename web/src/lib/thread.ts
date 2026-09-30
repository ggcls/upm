// A web worker standing in for one of upm's worker threads (./node.ts starts it). Its first
// message says which, with the `workerData` and the bits of `process` it needs; a `process`
// whose `worker_threads` has that data and a `parentPort` goes in before upm's worker loads,
// as that reads both at the top. Imports nothing of ./node.ts, which starts this file: Vite
// cannot bundle a worker that starts itself.

export interface Boot {
  name: string;
  workerData: unknown;
  process: { platform: string; arch: string; env: Record<string, string>; cwd: string };
}

type Listener = (data: unknown) => void;

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const listeners: Listener[] = [];
// What came before upm's worker listened. The pools hand nothing to a thread before its hello,
// but a message without a listener would be lost for good.
const early: unknown[] = [];

scope.onmessage = ({ data }) => {
  scope.onmessage = ({ data }) => {
    if (listeners.length === 0) early.push(data);
    for (const listener of listeners) listener(data);
  };
  void start(data as Boot);
};

async function start({ name, workerData, process }: Boot): Promise<void> {
  const parentPort = {
    on(type: string, listener: Listener) {
      if (type !== "message") return parentPort;
      listeners.push(listener);
      for (const data of early.splice(0)) listener(data);
      return parentPort;
    },
    postMessage: (message: unknown, transfer?: Transferable[]) =>
      scope.postMessage(message, transfer ?? []),
  };
  const threads = { isMainThread: false, parentPort, workerData };
  (globalThis as { process?: unknown }).process = {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    versions: {},
    cwd: () => process.cwd,
    getBuiltinModule: (id: string) =>
      id.replace(/^node:/, "") === "worker_threads" ? threads : undefined,
  };
  try {
    if (name === "registry") await import("upm/src/registry-worker.ts");
    else throw new Error(`no ${name} worker in a tab`);
  } catch (error) {
    // The page's `error` event gets the message only: the stack goes to this worker's console.
    console.error(error);
    // Thrown from a task, it reaches the page as the worker's `error` event.
    setTimeout(() => {
      throw error;
    });
  }
}
