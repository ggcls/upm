// The Storage panel: what this browser keeps on OPFS (./lib/opfs.ts) between visits, and a way
// to clear it. Walked afresh each time the tab is shown.
import { Fragment, useEffect, useState, type ReactNode } from "react";
import {
  clear,
  inspect,
  keptDocuments,
  keptPackages,
  type KeptDocument,
  type KeptPackage,
  type OpfsReport,
} from "../lib/opfs.ts";
import { formatBytes } from "./code.tsx";
import { Badge, Icon, IconButton, Spinner, Waiting } from "./ui.tsx";

/** What upm keeps at each top-level name. */
const KNOWN: Record<string, { label: string; about: string }> = {
  "upm-store": { label: "Store", about: "package files by content, shared by every tab" },
  "upm-docs": { label: "Registry documents", about: "the resolver's answers, kept while fresh" },
};

export function Storage({ onSize }: { onSize: (bytes: number) => void }) {
  // Undefined while walking, null where there is no OPFS.
  const [report, setReport] = useState<OpfsReport | Error | null>();
  const [error, setError] = useState<Error>();
  const [open, setOpen] = useState<string>();
  const load = () => {
    setReport(undefined);
    inspect().then(
      (report) => {
        setReport(report ?? null);
        if (report) onSize(report.bytes);
      },
      (error: Error) => setReport(error),
    );
  };
  useEffect(load, []);
  const remove = async (name?: string) => {
    setError(undefined);
    await clear(name).catch((error: Error) => setError(error));
    load();
  };

  if (report === undefined) {
    return (
      <Waiting>
        <Spinner /> Reading OPFS…
      </Waiting>
    );
  }
  if (report === null) return <Waiting>This browser has no OPFS.</Waiting>;
  if (report instanceof Error) return <Waiting>Could not read OPFS: {report.message}</Waiting>;
  return (
    <div className="text-xs">
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-(--editor-bg)/85 py-1 pr-1.5 pl-3 text-[11px] text-zinc-500 backdrop-blur-xl">
        <span title="OPFS, then all this origin keeps, as the browser counts it">
          {formatBytes(report.bytes)} on OPFS
          {report.usage !== undefined && (
            <>
              {" · "}
              {formatBytes(report.usage)} of {formatBytes(report.quota ?? 0)} for this site
            </>
          )}
        </span>
        {report.persisted !== undefined && (
          <span
            title={
              report.persisted
                ? "The browser keeps it when the disk runs low"
                : "The browser may evict it when the disk runs low"
            }
          >
            <Badge tone={report.persisted ? "green" : undefined}>
              {report.persisted ? "persistent" : "best-effort"}
            </Badge>
          </span>
        )}
        <span className="ml-auto flex">
          <IconButton icon="reload" title="Read OPFS again" onClick={load} />
          {report.entries.length > 0 && (
            <ClearButton title="Remove everything on OPFS" onClear={() => remove()}>
              Clear all
            </ClearButton>
          )}
        </span>
      </div>
      {error && <p className="px-3 py-1 font-mono text-red-600">{error.message}</p>}
      {report.entries.length === 0 ? (
        <Waiting>OPFS is empty. An install fills it.</Waiting>
      ) : (
        <table className="w-full">
          <tbody>
            {report.entries.map((entry) => {
              const known = KNOWN[entry.name];
              const expanded = open === entry.name;
              return (
                <Fragment key={entry.name}>
                  <tr className="border-t border-zinc-200/60 first:border-0 dark:border-zinc-800/60">
                    <td className="py-0.5 pl-1.5">
                      <button
                        type="button"
                        disabled={!known}
                        aria-expanded={known ? expanded : undefined}
                        onClick={() => setOpen(expanded ? undefined : entry.name)}
                        className="flex h-6 items-center gap-1 rounded px-1.5 font-medium enabled:hover:bg-zinc-200/70 dark:enabled:hover:bg-zinc-800"
                      >
                        <Icon
                          name="chevron"
                          className={`size-3 transition-transform ${known ? "" : "invisible"} ${expanded ? "rotate-90" : ""}`}
                        />
                        {known?.label ?? entry.name}
                      </button>
                    </td>
                    <td className="hidden leading-7 text-zinc-500 md:table-cell">
                      <span className="font-mono">{entry.name}</span>
                      {known && ` · ${known.about}`}
                    </td>
                    <td className="pl-3 text-right leading-7 whitespace-nowrap tabular-nums text-zinc-500">
                      {entry.files.toLocaleString()} files
                    </td>
                    <td className="pl-3 text-right leading-7 whitespace-nowrap tabular-nums">
                      {formatBytes(entry.bytes)}
                    </td>
                    <td className="w-px pr-1.5 pl-2 leading-7">
                      <ClearButton
                        title={`Remove ${entry.name} from OPFS`}
                        onClear={() => remove(entry.name)}
                      >
                        Clear
                      </ClearButton>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={5}>
                        {entry.name === "upm-store" ? <Packages /> : <Documents />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="px-3 py-1.5 text-[11px] text-zinc-400">
        A tab keeps its own copy of what it installed until it reloads.
      </p>
    </div>
  );
}

function ClearButton(props: { title: string; onClear: () => Promise<void>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      title={props.title}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void props.onClear().finally(() => setBusy(false));
      }}
      className="flex h-6 items-center gap-1 rounded px-1.5 text-xs whitespace-nowrap text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
    >
      {busy ? <Spinner /> : <Icon name="trash" className="size-3.5" />}
      {props.children}
    </button>
  );
}

/** Loads `list` once, then shows each item through `row`. */
function List<T>(props: { list: () => Promise<T[]>; empty: string; row: (item: T) => ReactNode }) {
  const [items, setItems] = useState<T[] | Error>();
  useEffect(() => {
    props.list().then(setItems, setItems);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (items === undefined) {
    return (
      <p className="flex items-center gap-2 py-1 pl-8 text-zinc-500">
        <Spinner /> Reading…
      </p>
    );
  }
  if (items instanceof Error) return <p className="py-1 pl-8 text-red-600">{items.message}</p>;
  if (items.length === 0) return <p className="py-1 pl-8 text-zinc-500">{props.empty}</p>;
  return (
    <ul className="max-h-60 overflow-auto pr-3 pb-1 pl-8 font-mono text-[11px]">
      {items.map((item) => props.row(item))}
    </ul>
  );
}

function Packages() {
  return (
    <List<KeptPackage>
      list={keptPackages}
      empty="No packages."
      row={(pkg) => (
        <li key={pkg.integrity} title={pkg.integrity} className="flex gap-3 py-px">
          <span className="min-w-0 truncate">
            {pkg.name ? `${pkg.name}@${pkg.version}` : pkg.integrity}
          </span>
          <span className="ml-auto shrink-0 text-zinc-500 tabular-nums">
            {pkg.files} files · {formatBytes(pkg.bytes)}
          </span>
        </li>
      )}
    />
  );
}

function Documents() {
  const now = Date.now();
  return (
    <List<KeptDocument>
      list={keptDocuments}
      empty="No documents."
      row={(doc) => {
        const left = doc.at + doc.maxAge * 1000 - now;
        return (
          <li
            key={`${doc.accept} ${doc.url}`}
            title={`${doc.url}\naccept: ${doc.accept || "*/*"}\nkept ${formatAge(now - doc.at)} ago`}
            className="flex gap-3 py-px"
          >
            <span className="min-w-0 truncate">{doc.url.replace(/^https?:\/\/[^/]+/, "")}</span>
            <span className="ml-auto flex shrink-0 gap-2 text-zinc-500 tabular-nums">
              {doc.accept.includes("vnd.npm.install-v1") && <Badge>abbreviated</Badge>}
              {formatBytes(doc.bytes)} ·{" "}
              {left > 0 ? `fresh ${formatAge(left)}` : <span className="text-zinc-400">stale</span>}
            </span>
          </li>
        );
      }}
    />
  );
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
