// The Install button: a run shows the package alone until it is asked to walk the tree and install.
import type { View } from "../app.tsx";
import { Icon } from "./ui.tsx";

type State = "idle" | "resolving" | "installing" | "done" | "failed";

export function installState(view: View): State {
  if (!view.requested) return "idle";
  if (view.resolved instanceof Error || view.installed instanceof Error) return "failed";
  if (!view.resolved) return "resolving";
  return view.installed && view.installed !== true ? "done" : "installing";
}

const BUTTON =
  "flex shrink-0 items-center gap-1.5 rounded-lg bg-amber-500 font-medium text-zinc-950 transition-colors hover:bg-amber-400 disabled:cursor-default disabled:bg-zinc-200 disabled:text-zinc-500 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400";

/** Small and filled, for a pane's title row: shown until the install is asked for. */
export function InstallChip({ view, onInstall }: { view: View; onInstall: () => void }) {
  if (view.requested || view.top instanceof Error) return null;
  return (
    <button
      type="button"
      title="Resolve the whole tree and install it in this tab"
      onClick={onInstall}
      className={`${BUTTON} h-5 px-2 text-[11px]`}
    >
      <Icon name="play" className="size-2.5" />
      Install
    </button>
  );
}

/**
 * Large and outlined, above a README beside the upm commands: shown until the install is asked
 * for, as a small screen has no Explorer title row for the chip. Reinstall lives in the Explorer.
 */
export function InstallButton({ view, onInstall }: { view: View; onInstall: () => void }) {
  if (view.requested) return null;
  return (
    <button
      type="button"
      title="Resolve the whole tree and install it in this tab"
      onClick={onInstall}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-3.5 text-sm font-medium text-amber-600 transition-colors hover:border-amber-500 dark:border-zinc-800 dark:text-amber-500 dark:hover:border-amber-500"
    >
      <Icon name="play" className="size-3.5" />
      Install in browser
    </button>
  );
}
