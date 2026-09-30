// The sidebar: a full-height island on the right of the page, resizable and hidden at a click,
// with the Explorer over the Dependencies. Each folds to its title row, for short screens.
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { clamp, Icon, ISLAND, Sash, SectionContext, useStored } from "./ui.tsx";

export function Sidebar(props: {
  explorer: ReactNode;
  dependencies: ReactNode;
  /** A path to show in the Explorer: unfolds it. */
  reveal?: { path: string };
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const { open, setOpen } = props;
  const [files, setFiles] = useState(true);
  const [deps, setDeps] = useState(true);
  // Unfold while rendering, so the tree opening the way to it commits already shown.
  const [revealed, setRevealed] = useState(props.reveal);
  if (props.reveal !== revealed) {
    setRevealed(props.reveal);
    setFiles(true);
  }
  // The island's own width; the margins around it grow with the page.
  const [width, setWidth] = useStored("sidebar-width", 288);
  // The Dependencies' height once dragged; until then, what its tree needs up to half.
  const [split, setSplit] = useStored("sidebar-split", undefined);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* On a small screen the toggle has its own line above the editor, and keeps it while the
          open sidebar floats over the page. */}
      <div
        className={`flex shrink-0 justify-end pr-2 max-sm:pb-1 sm:pr-5 lg:pr-9 xl:pr-15 ${open ? "sm:hidden" : ""}`}
      >
        <Toggle open={false} onClick={() => setOpen(true)} />
      </div>
      {/* A click beside the floating sidebar closes it. */}
      {open && <div className="absolute inset-0 z-20 sm:hidden" onClick={() => setOpen(false)} />}

      {/* Both views stay mounted, so folding keeps their scroll, selection and expansion. */}
      <aside
        style={{ width }}
        className={`relative box-content max-w-[75vw] shrink-0 flex-col pr-3 pl-3 sm:pr-6 lg:pr-10 xl:pr-16 max-sm:absolute max-sm:top-0 max-sm:right-0 max-sm:bottom-3 max-sm:z-20 max-sm:flex max-sm:origin-top-right max-sm:transition-[opacity,scale,visibility] max-sm:duration-200 max-sm:ease-out max-sm:motion-reduce:transition-none ${open ? "flex" : "hidden max-sm:invisible max-sm:scale-95 max-sm:opacity-0"}`}
      >
        {/* The sash sits in the gap beside the island. */}
        <div ref={ref} className={`flex min-h-0 flex-1 flex-col ${ISLAND}`}>
          <Section
            title="Explorer"
            open={files}
            toggle={() => setFiles(!files)}
            // Where the closed sidebar keeps its toggle.
            trailing={<Toggle open onClick={() => setOpen(false)} />}
          >
            {props.explorer}
          </Section>
          <Section
            title="Dependencies"
            open={deps}
            toggle={() => setDeps(!deps)}
            {...(files &&
              deps && {
                // Keeps the Explorer's title row in view.
                size: split === undefined ? "max-h-1/2" : "max-h-[calc(100%-2.75rem)]",
                style: { height: split },
                sash: (
                  <Sash
                    vertical
                    place="inset-x-0 -top-1 h-2"
                    onDrag={(e) => {
                      const box = ref.current?.getBoundingClientRect();
                      if (box) setSplit(clamp(box.bottom - e.clientY, 28, box.height - 44));
                    }}
                  />
                ),
              })}
          >
            {props.dependencies}
          </Section>
        </div>
        <Sash
          place="inset-y-0 left-0 w-3"
          onDrag={(e) => {
            const right = ref.current?.getBoundingClientRect().right ?? innerWidth;
            setWidth(clamp(right - e.clientX - 6, 180, 720));
          }}
        />
      </aside>
    </>
  );
}

function Toggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={open ? "Hide the sidebar" : "Show the sidebar"}
      onClick={onClick}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-200/60 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      <Icon name="sidebar" className="size-4" />
    </button>
  );
}

/**
 * A view that folds to its title row, which the view draws with `PaneTitle`. An open one fills
 * the height left, or with `size` takes its content's height (or `style`'s) within those bounds.
 */
function Section(props: {
  title: string;
  open: boolean;
  toggle: () => void;
  trailing?: ReactNode;
  size?: string;
  style?: CSSProperties;
  sash?: ReactNode;
  children: ReactNode;
}) {
  const { title, open, toggle, trailing } = props;
  return (
    <section
      style={open ? props.style : undefined}
      className={`relative flex flex-col not-first:border-t not-first:border-zinc-200 dark:not-first:border-zinc-800 ${open ? `min-h-0 ${props.size ?? "flex-1"}` : "shrink-0 [&>:not([data-pane-title])]:hidden"}`}
    >
      {props.sash}
      <SectionContext value={{ title, open, toggle, trailing }}>{props.children}</SectionContext>
    </section>
  );
}
