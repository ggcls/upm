// The "Install upm" card, as HTML: on the landing, and above a package's README.
import { svg } from "./hero.ts";

const INSTALL = "npm i -g upm";
// Lets npm install a release published moments ago; shown dimmed, but copied too.
const FLAGS = "--min-release-age 0";
const COPY = {
  className: "size-3.5",
  paths: `<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
};
const CHECK = { className: "size-3.5", paths: `<path d="M20 6 9 17l-5-5"/>` };

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A command to copy: `dim` is shown dimmed after it, and copied too. `bare` drops the frame. */
function command(text: string, dim = "", bare = false, prompt = "$") {
  const copy = dim ? `${text} ${dim}` : text;
  const frame = bare
    ? "gap-3"
    : "gap-2 rounded-xl border border-zinc-200 bg-(--chrome-bg) py-1.5 pr-1.5 pl-3 text-sm transition-colors hover:border-amber-500 data-copied:border-emerald-500! dark:border-zinc-800 dark:hover:border-amber-500";
  return `<button type="button" title="Copy to clipboard" data-copy="${escape(copy)}" class="group/copy flex w-full cursor-pointer items-center text-left font-mono ${frame}">
  <span class="text-amber-500 select-none">${prompt}</span>
  <code class="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-200">${escape(text)}${dim && ` <span class="text-zinc-400 dark:text-zinc-500">${escape(dim)}</span>`}</code>
  <span class="hidden shrink-0 font-sans text-xs font-medium text-emerald-600 group-data-copied/copy:inline dark:text-emerald-400">Copied!</span>
  <span data-icon class="shrink-0 ${bare ? "-my-1 rounded-md p-1.5" : "rounded-lg p-2"} bg-amber-500 text-zinc-950 transition-colors group-hover/copy:bg-amber-400 group-data-copied/copy:bg-emerald-500!">${svg(COPY, 2)}</span>
</button>`;
}

// The ways to install upm, one tab each: the scripts check for Node.js, then run npm.
const WAYS = [
  { id: "sh", label: "macOS / Linux", text: "curl -fsSL https://upm.sh/install.sh | sh" },
  { id: "ps1", label: "Windows", text: "irm https://upm.sh/install.ps1 | iex", prompt: ">" },
  { id: "npm", label: "npm", text: INSTALL, dim: FLAGS },
];
const TAB =
  "cursor-pointer rounded-md px-2 py-1 font-sans text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-800 aria-selected:bg-zinc-100 aria-selected:text-zinc-900 dark:hover:text-zinc-200 dark:aria-selected:bg-zinc-800 dark:aria-selected:text-zinc-100";

/** The install command, in a tab per way; the visitor's own system opens first. */
function installer(bare = false) {
  const first = globalThis.navigator?.userAgent.includes("Windows") ? "ps1" : "sh";
  return `<div data-tabs>
  <div role="tablist" class="${bare ? "mb-3" : "mb-2"} flex gap-1">${WAYS.map(
    (way) =>
      `<button type="button" role="tab" data-tab="${way.id}" aria-selected="${way.id === first}" class="${TAB}">${way.label}</button>`,
  ).join("")}</div>
  ${WAYS.map(
    (way) =>
      `<div role="tabpanel" data-panel="${way.id}"${way.id === first ? "" : " hidden"}>${command(way.text, way.dim, bare, way.prompt)}</div>`,
  ).join("")}
</div>`;
}

const KB = `<strong class="font-semibold text-amber-600 dark:text-amber-400">~256 KB</strong>`;

/**
 * The card: "Install upm" over a terminal. With `spec`, it has no title or frame, and a second command
 * adds that package with upm.
 */
export function installCard(className = "", spec?: string) {
  if (spec) {
    return `<aside class="${className} space-y-3">
  ${installer()}
  ${command(`upm add ${spec}`)}
</aside>`;
  }
  return `<aside class="${className}">
  <h2 class="mb-3 text-center text-sm font-semibold text-zinc-900 dark:text-zinc-100">Install upm</h2>
  <div class="space-y-1 rounded-2xl border border-zinc-200 bg-(--editor-bg) p-5 font-mono text-sm shadow-2xl shadow-amber-500/10 dark:border-zinc-800">
  ${installer(true)}
  <p class="pt-2 text-xs text-zinc-400 dark:text-zinc-500">Works with Node.js, your .npmrc and npm, pnpm or bun lockfiles. Takes ${KB} of disk space (85 KB packed).</p>
  </div>
</aside>`;
}

/** Makes the card's tabs switch and its commands copy on click. Returns a cleanup. */
export function bindInstall(card: HTMLElement): () => void {
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const onClick = (e: MouseEvent) => {
    const tab = (e.target as Element).closest<HTMLElement>("[data-tab]");
    if (tab) {
      const tabs = tab.closest("[data-tabs]")!;
      for (const other of tabs.querySelectorAll<HTMLElement>("[data-tab]")) {
        other.ariaSelected = String(other === tab);
      }
      for (const panel of tabs.querySelectorAll<HTMLElement>("[data-panel]")) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      }
      return;
    }
    const button = (e.target as Element).closest<HTMLElement>("[data-copy]");
    if (!button) return;
    const icon = button.querySelector<HTMLElement>("[data-icon]")!;
    void navigator.clipboard.writeText(button.dataset.copy!);
    icon.innerHTML = svg(CHECK, 2.5);
    button.dataset.copied = "";
    clearTimeout(timers.get(button));
    timers.set(
      button,
      setTimeout(() => {
        icon.innerHTML = svg(COPY, 2);
        delete button.dataset.copied;
      }, 1500),
    );
  };
  card.addEventListener("click", onClick);
  return () => {
    card.removeEventListener("click", onClick);
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
