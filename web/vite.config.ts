import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { readme } from "./readme.ts";

// upm from source, not from a build: `upm/resolver` is the portable entry, `upm/src/*` reaches
// the modules it does not export yet (tar, integrity).
const src = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * upm's pools start a thread from src/workers.ts, whose URLs point at the worker's .ts file.
 * Here each is a name instead, which src/lib/node.ts starts as src/lib/thread.ts. And upm says it
 * has no side effects, but a worker module is nothing else: kept whole when thread.ts loads it.
 */
const workers: Plugin = {
  name: "upm-workers",
  enforce: "pre",
  resolveId(id, importer) {
    if (id === "./workers.ts" && importer?.startsWith(src)) return "\0upm-workers";
  },
  load(id) {
    if (id !== "\0upm-workers") return;
    return ["unpack", "link", "registry"]
      .map((name) => `export const ${name}Worker = () => new URL("upm-worker:${name}");`)
      .join("\n");
  },
  transform(code, id) {
    if (id.startsWith(src) && id.endsWith("-worker.ts")) return { code, moduleSideEffects: true };
  },
};

export default defineConfig({
  plugins: [
    workers,
    react(),
    // Serves index.html for every route, `/npm/<spec>` included, on any host it deploys to.
    nitro(),
    tailwindcss(),
    readme(
      fileURLToPath(new URL("../README.md", import.meta.url)),
      "https://github.com/unjs/upm/blob/main/",
    ),
  ],
  // src/lib/thread.ts loads upm's worker only once its `process` is in place: a lazy chunk,
  // which the default iife format cannot split out.
  worker: { format: "es", plugins: () => [workers] },
  // Workers build as the client environment too, so they get maps as well.
  environments: { client: { build: { sourcemap: true } } },
  resolve: {
    alias: [
      { find: /^upm\/resolver$/, replacement: `${src}resolver.ts` },
      { find: /^upm\/src\//, replacement: src },
      // nitro's dev error handler imports pathe without declaring it, and upm does not hoist.
      { find: /^pathe$/, replacement: fileURLToPath(import.meta.resolve("pathe")) },
    ],
  },
});
