// The Explorer view: the project in the shape upm's install leaves it, from the first moment.
// package.json, the package's files where its link shows them, the lockfile; then everything
// the install adds around them, in place.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { View } from "../app.tsx";
import type { Size } from "../lib/client.ts";
import { formatBytes } from "./code.tsx";
import type { InstalledFile } from "../lib/install.ts";
import { InstallChip, installState } from "./install-button.tsx";
import { ErrorBox, Icon, IconButton, PaneTitle, Spinner, Waiting } from "./ui.tsx";

export const LOCK = "upm.lock";

/** Where a tarball's file shows in the tree: installed, as upm would lay it out. */
export function treePath(name: string, path = "") {
  return `node_modules/${name}/${path}`;
}

/**
 * The project's files, each package's once: an opened link shows the `.upm` copy it points
 * to. Symlinks count apart, with no bytes. And the store's apart, which holds every install's
 * content, not only this one's.
 */
export function tally(files: Map<string, InstalledFile>, links: Map<string, string> | undefined) {
  const project = { files: 0, links: 0, bytes: 0 };
  const store = { files: 0, links: 0, bytes: 0 };
  const opened = [...(links?.keys() ?? [])].map((at) => `${at}/`);
  for (const [path, file] of files) {
    const into = path.startsWith("~/") ? store : project;
    if (into === project && opened.some((at) => path.startsWith(at))) continue;
    if (file.link !== undefined) {
      into.links++;
      continue;
    }
    into.files++;
    into.bytes += file.size;
  }
  return { project, store };
}

export function Explorer(props: {
  view: View | undefined;
  /** Tree path -> file: what has landed so far, or the installed tree. */
  files: Map<string, InstalledFile> | undefined;
  /** The installed tree's opened links: tree path -> target. */
  links: Map<string, string> | undefined;
  /** What the install will write, as the registry tells it: shown until the install lands. */
  estimate?: Size;
  /** How far the install has got, 0 to 1, or pending while that cannot be measured yet. */
  progress?: number | "pending";
  picked: number;
  selected: string;
  /** A path to open the way to, scroll to and focus. */
  reveal?: { path: string };
  onSelect: (path: string) => void;
  onInstall: () => void;
  onReinstall: () => void;
}) {
  const { view, files, picked, selected, onSelect } = props;
  if (!view) {
    return (
      <>
        <PaneTitle />
        <Waiting>Resolve a package to browse its files.</Waiting>
      </>
    );
  }
  const { tarball, resolved, installed } = view;
  const lock = resolved && !(resolved instanceof Error) ? resolved.lockfile : undefined;
  const hasTree = files !== undefined || lock !== undefined;
  const count = files && tally(files, props.links);
  const estimated = !!count && !!props.estimate && props.estimate.files > count.project.files;

  return (
    <>
      <PaneTitle>
        <span className="flex min-w-0 items-center gap-1.5">
          {installed === true && <Spinner className="size-3.5 text-zinc-300 dark:text-zinc-700" />}
          <span
            className="truncate"
            title={
              estimated
                ? "An estimate from the registry's counts, until the install lands"
                : count?.store.files
                  ? `upm's store holds ${count.store.files} files, ${formatBytes(count.store.bytes)}, from the installs in this tab`
                  : undefined
            }
          >
            {count && (
              // Fresh per run: it counts up from this run's first files, not the last run's.
              <Count
                key={view.id}
                {...(estimated ? { ...props.estimate!, links: 0 } : count.project)}
                estimated={estimated}
              />
            )}
          </span>
        </span>
        <InstallChip view={view} onInstall={props.onInstall} />
        {(installState(view) === "done" || installState(view) === "failed") && (
          <IconButton
            icon="reload"
            title="Reinstall: resolve and install afresh"
            onClick={props.onReinstall}
          />
        )}
      </PaneTitle>
      {props.progress !== undefined && (
        <div className="h-0.5 shrink-0 overflow-hidden bg-zinc-200 dark:bg-zinc-800">
          {props.progress === "pending" ? (
            <div className="h-full w-1/3 animate-pending bg-amber-500 motion-reduce:w-full motion-reduce:animate-pulse" />
          ) : (
            <div
              className="h-full bg-amber-500 transition-[width] duration-300 ease-out"
              style={{ width: `${props.progress * 100}%` }}
            />
          )}
        </div>
      )}
      {tarball instanceof Error && view.top && !(view.top instanceof Error) && (
        <div className="shrink-0 px-3 pb-2">
          <ErrorBox error={tarball} title="Tarball failed" />
        </div>
      )}
      {installed instanceof Error && (
        <div className="shrink-0 px-3 pb-2">
          <ErrorBox error={installed} title="Install failed" />
        </div>
      )}
      {hasTree && (
        // Fresh per run: expansion starts over.
        <Tree
          key={view.id}
          root={treePath(view.name)}
          files={files}
          links={props.links}
          lock={lock}
          selected={selected}
          reveal={props.reveal}
          onSelect={onSelect}
        />
      )}
      <div className="shrink-0 border-t border-zinc-200 empty:hidden dark:border-zinc-800">
        {!tarball && !(view.top instanceof Error) && (
          <Pending name={treePath(view.name).slice(0, -1)}>fetching tarball</Pending>
        )}
        {view.requested && !resolved && <Pending name={LOCK}>resolving · {picked} picked</Pending>}
        {resolved instanceof Error && (
          <Pending name={LOCK} failed>
            resolve failed
          </Pending>
        )}
      </div>
      {!hasTree && <div className="flex-1" />}
    </>
  );
}

function Count(props: { files: number; links: number; bytes: number; estimated: boolean }) {
  const files = Math.round(useCountUp(props.files));
  const bytes = useCountUp(props.bytes);
  const links = props.links ? ` (${props.links} links)` : "";
  return `${props.estimated ? "~" : ""}${files} files${links} · ${formatBytes(bytes)}`;
}

/** `target`, reached in a short ease from where the last one left it. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target);
  const at = useRef(target);
  useEffect(() => {
    const from = at.current;
    if (from === target) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      at.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, (now - start) / 600);
      at.current = from + (target - from) * (1 - (1 - t) ** 3);
      setShown(at.current);
      if (t < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return shown;
}

/** A row for a tree entry that has not landed yet. */
function Pending({
  name,
  failed,
  children,
}: {
  name: string;
  failed?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-xs text-zinc-500">
      <Icon name={name === LOCK ? "lock" : "package"} className="size-3.5 opacity-60" />
      <span className="truncate font-mono">{name}</span>
      <span
        className={`ml-auto flex shrink-0 items-center gap-1.5 ${failed ? "text-red-600 dark:text-red-400" : ""}`}
      >
        {!failed && <Spinner />}
        {children}
      </span>
    </div>
  );
}

interface Entry {
  name: string;
  /** Its tree path; a directory's has no trailing slash. */
  path: string;
  /** A directory's entries. */
  entries?: Map<string, Entry>;
}

function Tree(props: {
  root: string;
  files: Map<string, InstalledFile> | undefined;
  links: Map<string, string> | undefined;
  lock: string | undefined;
  selected: string;
  reveal?: { path: string };
  onSelect: (path: string) => void;
}) {
  const { files, links, lock, selected, reveal, onSelect } = props;
  const top = useMemo(() => {
    const paths = [...(files?.keys() ?? [])];
    if (lock !== undefined && !files?.has(LOCK)) paths.push(LOCK);
    return build(paths);
  }, [files, lock]);
  // Closed, except the way down to the package, where its README sits. What lands later comes
  // in closed too, so rows already shown stay where they are.
  const [open, setOpen] = useState(() => new Set(ancestors(props.root)));
  const list = useRef<HTMLUListElement>(null);
  const shown = useRef("");

  // A directory can hold the selection too (clicked, revealed or followed to) while the editor
  // keeps its file; picking a file takes it back.
  const [dir, setDir] = useState<string>();
  const [last, setLast] = useState(selected);
  if (selected !== last) {
    setLast(selected);
    setDir(undefined);
  }
  const current = dir ?? selected;

  // Open the way to a revealed path while rendering, so the row is there once it commits.
  const [target, setTarget] = useState(reveal);
  const [seen, setSeen] = useState(reveal);
  function go(path: string) {
    setOpen((prev) => new Set([...prev, ...ancestors(path)]));
    setTarget({ path });
    setDir(find(top, path)?.entries ? path : undefined);
  }
  if (reveal !== seen) {
    setSeen(reveal);
    if (reveal) go(reveal.path);
  }
  useLayoutEffect(() => {
    if (!target) return;
    const row = list.current?.querySelector<HTMLElement>(
      `[data-path="${CSS.escape(target.path)}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }, [target]);

  // Follow a link to its target, when the tree has it: a file opens too.
  function follow(entry: Entry, link: string) {
    const path = resolve(entry.path, link);
    if (files?.has(path)) onSelect(path);
    else if (!find(top, path)?.entries) return;
    go(path);
  }

  // Bring the selected row into view once: when it changes, or when it first lands.
  useLayoutEffect(() => {
    const box = list.current;
    const row = box?.querySelector("[aria-current]");
    if (!box || !row || shown.current === current || !box.clientHeight) return;
    shown.current = current;
    const outer = box.getBoundingClientRect();
    const inner = row.getBoundingClientRect();
    if (inner.top < outer.top || inner.bottom > outer.bottom) {
      box.scrollTop += inner.top - outer.top - (outer.height - inner.height) / 2;
    }
  });

  function toggle(path: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  function size(entry: Entry): string | undefined {
    if (entry.path === LOCK && lock !== undefined) return formatBytes(lock.length);
    const file = files?.get(entry.path);
    return file && formatBytes(file.size);
  }

  function rows(entries: Map<string, Entry>, depth: number): ReactNode {
    return [...entries.values()].sort(byKind(depth === 0)).map((entry) => {
      const expanded = !!entry.entries && open.has(entry.path);
      const link = links?.get(entry.path) ?? files?.get(entry.path)?.link;
      const text = link === undefined ? size(entry) : undefined;
      return (
        <li key={entry.name}>
          <button
            type="button"
            title={entry.path}
            data-path={entry.path}
            aria-current={entry.path === current || undefined}
            onClick={() => {
              if (entry.entries) {
                toggle(entry.path);
                setDir(entry.path);
              } else {
                setDir(undefined);
                onSelect(entry.path);
              }
            }}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={`flex h-[22px] w-full items-center gap-1.5 pr-3 text-left whitespace-nowrap focus:ring-1 focus:ring-amber-500/60 focus:outline-none focus:ring-inset ${
              entry.path === current
                ? "bg-amber-500/15 text-zinc-900 dark:text-zinc-100"
                : "hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60"
            }`}
          >
            <span className="flex w-3 shrink-0 justify-center text-zinc-400">
              {entry.entries && (
                <Icon
                  name="chevron"
                  className={`size-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                />
              )}
            </span>
            <span className="truncate">
              {entry.entries ? <StoreName name={entry.name} /> : entry.name}
            </span>
            {link !== undefined && (
              // A button cannot hold a button: the row stays one, this a link-like span.
              <span
                role="link"
                title={`Go to ${link}`}
                onClick={(event) => {
                  event.stopPropagation();
                  follow(entry, link);
                }}
                className="ml-auto max-w-1/2 shrink-0 truncate pl-2 text-[11px] text-zinc-400 hover:text-amber-600 hover:underline dark:hover:text-amber-400"
              >
                → {link}
              </span>
            )}
            {text && (
              <span className="ml-auto max-w-1/2 shrink-0 truncate pl-2 text-[11px] text-zinc-400 tabular-nums">
                {text}
              </span>
            )}
          </button>
          {expanded && (
            <ul className="relative">
              <li
                aria-hidden
                style={{ left: `${depth * 12 + 14}px` }}
                className="absolute inset-y-0 border-l border-zinc-200 dark:border-zinc-800"
              />
              {rows(entry.entries!, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  return (
    <ul ref={list} className="min-h-0 flex-1 overflow-auto pb-4 text-xs">
      {rows(top, 0)}
    </ul>
  );
}

// A `.upm` entry, `<name>@<version>-<hash>`: the 22-char hash is grayed out.
const STORE_ENTRY = /^(.+@.+)(-[\w-]{22})$/;

function StoreName({ name }: { name: string }) {
  const match = STORE_ENTRY.exec(name);
  if (!match) return name;
  return (
    <>
      {match[1]}
      <span className="text-zinc-400 dark:text-zinc-500">{match[2]}</span>
    </>
  );
}

function build(paths: string[]): Map<string, Entry> {
  const top = new Map<string, Entry>();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let entries = top;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      let entry = entries.get(name);
      if (!entry) {
        entry = { name, path: parts.slice(0, i + 1).join("/") };
        entries.set(name, entry);
      }
      if (i === parts.length - 1) break;
      entries = entry.entries ??= new Map();
    }
  }
  return top;
}

/** The store (`~`) on top, then directories, then files; dot names sort first in each. */
function byKind(top: boolean) {
  const rank = (entry: Entry) => (top && entry.name === "~" ? -1 : entry.entries ? 0 : 1);
  return (a: Entry, b: Entry) => rank(a) - rank(b) || a.name.localeCompare(b.name);
}

function find(top: Map<string, Entry>, path: string): Entry | undefined {
  let entries: Map<string, Entry> | undefined = top;
  let entry: Entry | undefined;
  for (const name of path.split("/")) {
    entry = entries?.get(name);
    entries = entry?.entries;
  }
  return entry;
}

/** The file a symlink leads to, through any chain of links, or undefined when not in the tree. */
export function linked(
  files: Map<string, InstalledFile>,
  file: InstalledFile,
): InstalledFile | undefined {
  for (let hops = 0; file.link !== undefined; hops++) {
    const next = hops < 16 ? files.get(resolve(file.path, file.link)) : undefined;
    if (!next) return undefined;
    file = next;
  }
  return file;
}

/** A relative link target, as a tree path from the link's own directory. */
function resolve(from: string, target: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

function ancestors(root: string): string[] {
  const parts = root.split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
