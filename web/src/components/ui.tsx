// Small pieces shared by the panes.
import { createContext, useContext, useState, type ReactNode } from "react";

// Stroke icons on a 24px grid, drawn after lucide.
const ICONS = {
  files: (
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </>
  ),
  deps: (
    <>
      <path d="M21 12h-8M21 6H8M21 18h-8" />
      <path d="M3 6v4c0 1.1.9 2 2 2h3M3 10v6c0 1.1.9 2 2 2h3" />
    </>
  ),
  requests: <path d="m3 16 4 4 4-4M7 20V4m14 4-4-4-4 4m4-4v16" />,
  warning: (
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4m0 4h.01" />
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6m0-6 6 6" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  maximize: <path d="m18 15-6-6-6 6" />,
  restore: <path d="m6 9 6 6 6-6" />,
  play: <path d="M6 3v18l14-9Z" />,
  home: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20" />
    </>
  ),
  repo: (
    <>
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 3v12m12-6a9 9 0 0 1-9 9" />
    </>
  ),
  github: (
    <>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </>
  ),
  npm: (
    <>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 16V8h8v8m-4-5v5" />
    </>
  ),
  package: (
    <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73ZM12 22V12M3.3 7l7.7 4.73a2 2 0 0 0 2 0L20.7 7M7.5 4.27l9 5.15" />
  ),
  server: (
    <>
      <rect width="20" height="8" x="2" y="2" rx="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" />
      <path d="M6 6h.01M6 18h.01" />
    </>
  ),
  copy: (
    <>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  download: <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3" />,
  reload: <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8m0-5v5h-5" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  external: (
    <path d="M15 3h6v6M10 14 21 3m-3 10v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  ),
  terminal: <path d="m4 17 6-6-6-6m8 14h8" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M15 4v16" />
    </>
  ),
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  lock: (
    <>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  storage: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5" />
      <path d="M3 12a9 3 0 0 0 18 0" />
    </>
  ),
  trash: (
    <path d="M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  ),
  cpu: (
    <>
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M15 2v2m0 16v2M2 15h2M2 9h2m16 6h2m-2-6h2M9 2v2m0 16v2" />
    </>
  ),
};

export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      {ICONS[name]}
    </svg>
  );
}

export function Pulse() {
  return (
    <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
  );
}

/** A ring with a turning arc, for work under way. */
export function Spinner({ className = "size-3" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={`shrink-0 animate-spin ${className}`}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" className="opacity-20" />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="text-amber-500"
      />
    </svg>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: "red" | "green" }) {
  const color =
    tone === "red"
      ? "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300"
      : tone === "green"
        ? "border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300"
        : "border-zinc-300 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400";
  return (
    <span className={`shrink-0 rounded border px-1 font-sans text-[10px] leading-4 ${color}`}>
      {children}
    </span>
  );
}

export function ErrorBox({ error, title }: { error: Error; title?: string }) {
  const code = (error as { code?: string }).code;
  return (
    <div className="flex gap-3 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
      <Icon name="error" className="mt-0.5 size-4" />
      <div className="min-w-0">
        {title && <p className="mb-1 font-medium">{title}</p>}
        <p className="font-mono text-xs break-words">
          {code && <b className="mr-2">{code}</b>}
          {error.message}
        </p>
      </div>
    </div>
  );
}

/** Centered text for a pane with nothing to show yet. */
export function Waiting({ children, live }: { children: ReactNode; live?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 p-6 text-center text-xs text-zinc-500">
      {live && <Pulse />}
      {children}
    </div>
  );
}

/** The sidebar section a pane sits in: its title row names it and folds it. */
export const SectionContext = createContext<
  { title: string; open: boolean; toggle: () => void; trailing?: ReactNode } | undefined
>(undefined);

/**
 * The row of a pane's details atop it. In a sidebar section the section's name comes first, on
 * its own row that folds the section and stays shown while the rest is hidden.
 */
export function PaneTitle({ children }: { children?: ReactNode }) {
  const section = useContext(SectionContext);
  const details = children && (
    <div className="flex h-7 items-center justify-between gap-2 pr-3 pl-2">{children}</div>
  );
  return (
    <div data-pane-title className="shrink-0 text-[11px] text-zinc-500">
      {section && (
        <div
          className={`flex items-center justify-between gap-2 pl-1 ${section.trailing ? "h-11 pr-1.5" : "h-7 pr-3"}`}
        >
          <button
            type="button"
            aria-expanded={section.open}
            onClick={section.toggle}
            className="flex h-6 shrink-0 items-center gap-1 rounded px-1 font-medium tracking-wide text-zinc-600 uppercase hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <Icon
              name="chevron"
              className={`size-3 transition-transform ${section.open ? "rotate-90" : ""}`}
            />
            {section.title}
          </button>
          {section.trailing}
        </div>
      )}
      {(!section || section.open) && details}
    </div>
  );
}

/** A button, or with `href` a link that looks like one and loads the page afresh. */
export function IconButton(props: {
  icon: IconName;
  title: string;
  onClick?: () => void;
  href?: string;
  children?: ReactNode;
}) {
  const className =
    "flex h-6 items-center gap-1 rounded px-1.5 text-xs text-zinc-500 hover:bg-zinc-200/70 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100";
  const content = (
    <>
      <Icon name={props.icon} className="size-3.5" />
      {props.children}
    </>
  );
  if (props.href !== undefined) {
    return (
      // A target: ./router.ts keeps only links without one in the page.
      <a href={props.href} target="_self" title={props.title} className={className}>
        {content}
      </a>
    );
  }
  return (
    <button type="button" title={props.title} onClick={props.onClick} className={className}>
      {content}
    </button>
  );
}

/**
 * A thin edge to drag a pane's size from. `onDrag` gets the pointer; the pane works out its size.
 */
/** A raised surface on the page, like the sidebar and the panel: frosted glass over what scrolls under it. */
export const ISLAND =
  "overflow-hidden rounded-2xl bg-(--editor-bg)/85 backdrop-blur-xl backdrop-saturate-150 border border-zinc-200/70 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-8px_rgb(0_0_0/0.12)] dark:border-white/10 dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_16px_40px_-8px_rgb(0_0_0/0.7)]";

/** Segmented tabs; `grow` spreads them over the row. */
export function Tabs({ grow, children }: { grow?: boolean; children: ReactNode }) {
  return (
    <div
      role="tablist"
      className={`flex rounded-[10px] bg-zinc-100 p-0.5 dark:bg-zinc-950/60 ${grow ? "flex-1 *:flex-1" : ""}`}
    >
      {children}
    </div>
  );
}

/** Give `title` when the tab shows only an icon: it names the tab. */
export function Tab(props: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      title={props.title}
      aria-label={props.title}
      aria-selected={props.active}
      onClick={props.onClick}
      className={`flex h-7 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors ${
        props.active
          ? "bg-(--editor-bg) text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
          : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
      }`}
    >
      {props.children}
    </button>
  );
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

/** A number kept in `localStorage` across visits, such as a size dragged to. */
export function useStored<T extends number | undefined>(key: string, fallback: T) {
  const [value, setValue] = useState<number | T>(() => {
    try {
      const n = Number.parseFloat(localStorage.getItem(key)!);
      return Number.isFinite(n) ? n : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (n: number) => {
    setValue(n);
    try {
      localStorage.setItem(key, String(Math.round(n)));
    } catch {}
  };
  return [value, set] as const;
}

export function Sash({
  vertical,
  place,
  onDrag,
}: {
  vertical?: boolean;
  /** Where it sits in its box, in place of the gap beside it. Its line runs down the middle. */
  place?: string;
  onDrag: (e: PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={(e) => {
        e.preventDefault();
        // Keep the drag's moves here, even over the content it passes.
        e.currentTarget.setPointerCapture(e.pointerId);
        const up = () => {
          removeEventListener("pointermove", onDrag);
          removeEventListener("pointerup", up);
          document.body.style.cursor = "";
        };
        addEventListener("pointermove", onDrag);
        addEventListener("pointerup", up);
        document.body.style.cursor = vertical ? "row-resize" : "col-resize";
      }}
      className={`group/sash absolute z-10 flex ${
        vertical ? "cursor-row-resize flex-col" : "cursor-col-resize"
      } justify-center ${place ?? (vertical ? "inset-x-0 -top-2 h-1" : "inset-y-0 -right-0.5 w-1")}`}
    >
      <div
        className={`transition-colors delay-100 group-hover/sash:bg-amber-500/60 ${vertical ? "h-1" : "w-1"}`}
      />
    </div>
  );
}
