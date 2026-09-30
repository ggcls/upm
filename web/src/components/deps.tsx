// The Dependencies view: the live picks while resolving, the full graph once done.
import { useState } from "react";
import type { ResolvedPackage, Resolution } from "upm/resolver";
import type { View } from "../app.tsx";
import type { Resolved } from "../lib/client.ts";
import { pathOf } from "../lib/route.ts";
import { InstallChip } from "./install-button.tsx";
import { Badge, ErrorBox, Icon, PaneTitle, Pulse, Waiting } from "./ui.tsx";

export interface Edge {
  name: string;
  version: string;
  optional: boolean;
  /** Its record, once the graph is done. */
  pkg?: ResolvedPackage;
}

/** Parent key -> the packages the walk reached first from it, as it picks them. */
export type Picks = Map<string, Edge[]>;

/** Edges out of a key, `""` for the root. */
type Edges = (key: string) => Edge[];

export function Dependencies(props: {
  view: View | undefined;
  onInstall: () => void;
  picks: Picks;
  picked: number;
  resolved: Resolved | Error | undefined;
}) {
  const { view, picks, picked, resolved } = props;
  // Before the Install button, there is no walk to wait for.
  const started = !!view?.requested;
  const done = resolved instanceof Error ? undefined : resolved;
  const edges: Edges = done
    ? (key) =>
        (key ? edgesOf(done.resolution.packages[key]) : rootEdges(done.resolution)).map((edge) => ({
          ...edge,
          pkg: done.resolution.packages[`${edge.name}@${edge.version}`],
        }))
    : (key) => picks.get(key) ?? [];
  const roots = edges("");

  return (
    <>
      <PaneTitle>
        {done ? (
          `${Object.keys(done.resolution.packages).length} packages`
        ) : resolved || !started ? null : (
          <span className="flex items-center gap-2">
            <Pulse /> {picked} picked
          </span>
        )}
      </PaneTitle>
      {resolved instanceof Error && (
        <div className="px-3 pb-3">
          <ErrorBox error={resolved} title="Resolve failed" />
        </div>
      )}
      {roots.length > 0 ? (
        <ul className="min-h-0 flex-1 overflow-auto pb-4 font-mono text-xs">
          {roots.map((edge) => (
            <Node key={edge.name} edges={edges} edge={edge} depth={0} path={[]} />
          ))}
        </ul>
      ) : (
        !resolved && (
          // A roomy default in a sidebar sized to its content, that still gives way to the Explorer.
          <div className="flex min-h-0 grow basis-40 flex-col *:flex-1">
            {started ? (
              <Waiting live>waiting for the first pick</Waiting>
            ) : view && !(view.top instanceof Error) ? (
              <div className="flex flex-col items-center justify-center gap-3 p-6 text-center text-xs text-zinc-500">
                Install to resolve its tree.
                <InstallChip view={view} onInstall={props.onInstall} />
              </div>
            ) : (
              <Waiting>Resolve a package to see its tree.</Waiting>
            )}
          </div>
        )
      )}
    </>
  );
}

function Node(props: { edges: Edges; edge: Edge; depth: number; path: string[] }) {
  const { edges, edge, depth, path } = props;
  const { pkg } = edge;
  const key = `${edge.name}@${edge.version}`;
  const cycle = path.includes(key);
  const children = cycle ? [] : edges(key);
  const [open, setOpen] = useState(depth < 1);

  return (
    <li>
      {/* The row folds; it ends in a link, which a button could not hold. */}
      <div
        onClick={() => children.length > 0 && setOpen(!open)}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={`flex h-[22px] w-full min-w-fit items-center gap-1.5 pr-3 whitespace-nowrap hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60 ${children.length > 0 ? "cursor-pointer" : ""}`}
      >
        {children.length > 0 ? (
          <button
            type="button"
            aria-label={open ? "Collapse" : "Expand"}
            aria-expanded={open}
            className="flex w-3 justify-center text-zinc-400"
          >
            <Icon
              name="chevron"
              className={`size-3 transition-transform ${open ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <span className="w-3" />
        )}
        <span>{edge.name}</span>
        <span className="text-amber-600 dark:text-amber-500">{edge.version}</span>
        {edge.optional && <Badge>optional</Badge>}
        {pkg?.os && <Badge>{pkg.os.join(" ")}</Badge>}
        {pkg?.cpu && <Badge>{pkg.cpu.join(" ")}</Badge>}
        {pkg?.peers && <Badge>{Object.keys(pkg.peers).length} peers</Badge>}
        {cycle && <Badge tone="red">cycle</Badge>}
        {children.length > 0 && !open && (
          <span className="text-[10px] text-zinc-400">{children.length}</span>
        )}
        <a
          href={pathOf(key)}
          target="_blank"
          title={`Open ${key} in a new tab`}
          onClick={(e) => e.stopPropagation()}
          className="-my-1 ml-auto rounded p-1 text-zinc-300 hover:bg-zinc-300/60 hover:text-amber-600 dark:text-zinc-600 dark:hover:bg-zinc-700"
        >
          <Icon name="external" className="size-3" />
        </a>
      </div>
      {open && children.length > 0 && (
        <ul className="relative">
          <li
            aria-hidden
            style={{ left: `${depth * 12 + 14}px` }}
            className="absolute inset-y-0 border-l border-zinc-200 dark:border-zinc-800"
          />
          {children.map((child) => (
            <Node
              key={child.name}
              edges={edges}
              edge={child}
              depth={depth + 1}
              path={[...path, key]}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function edgesOf(pkg: ResolvedPackage | undefined): Edge[] {
  if (!pkg) return [];
  return [
    ...Object.entries(pkg.dependencies).map(([name, version]) => ({
      name,
      version,
      optional: false,
    })),
    ...Object.entries(pkg.optionalDependencies ?? {}).map(([name, version]) => ({
      name,
      version,
      optional: true,
    })),
  ];
}

function rootEdges(resolution: Resolution): Edge[] {
  return Object.entries(resolution.root.dependencies).map(([name, version]) => ({
    name,
    version,
    optional: false,
  }));
}
