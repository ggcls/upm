// The package's downloads over the last year, from npm's downloads API, as a sparkline by week
// or by month.
import { useEffect, useState } from "react";

const API = "https://api.npmjs.org/downloads/range/";

type Period = "weekly" | "monthly";

interface Point {
  /** The period's first day, `YYYY-MM-DD`. */
  start: string;
  count: number;
}

type Series = Record<Period, Point[]>;

// Kept for the tab: a package opened again draws at once.
const asked = new Map<string, Promise<Series>>();

// The last choice, for the next package.
let chosen: Period = "weekly";

function series(name: string): Promise<Series> {
  let pending = asked.get(name);
  if (!pending) {
    // From the first of the month a year back, so the months are whole.
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
    const range = `${from.toISOString().slice(0, 10)}:${now.toISOString().slice(0, 10)}`;
    pending = fetch(`${API}${range}/${name}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: { downloads?: { day: string; downloads: number }[] }) => {
        const days = body.downloads ?? [];
        // The last day or two are not counted yet and come back as 0.
        for (let i = 0; i < 3 && days.at(-1)?.downloads === 0; i++) days.pop();
        const sum = (list: typeof days) => list.reduce((total, d) => total + d.downloads, 0);
        // Whole weeks back from the last day.
        const weekly: Point[] = [];
        for (let end = days.length; end >= 7 && weekly.length < 52; end -= 7) {
          weekly.unshift({ start: days[end - 7]!.day, count: sum(days.slice(end - 7, end)) });
        }
        // Calendar months, without the one still under way.
        const monthly: Point[] = [];
        const current = days.at(-1)?.day.slice(0, 7);
        for (let i = 0; i < days.length;) {
          const month = days[i]!.day.slice(0, 7);
          let end = i;
          while (days[end]?.day.startsWith(month)) end++;
          if (month !== current)
            monthly.push({ start: days[i]!.day, count: sum(days.slice(i, end)) });
          i = end;
        }
        return { weekly, monthly };
      });
    pending.catch(() => asked.delete(name));
    asked.set(name, pending);
  }
  return pending;
}

const number = new Intl.NumberFormat("en-US");
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const month = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Nothing when the registry has no count for it, such as a package only on another registry. */
export function Downloads({ name, className }: { name: string; className?: string }) {
  const [all, setAll] = useState<Series | null>();
  const [period, setPeriod] = useState(chosen);
  const [hover, setHover] = useState<number>();
  useEffect(() => {
    let current = true;
    setAll(undefined);
    series(name).then(
      (s) => current && setAll(s.weekly.length > 1 && s.weekly.some((w) => w.count) ? s : null),
      () => current && setAll(null),
    );
    return () => void (current = false);
  }, [name]);

  if (all === null) return null;
  const data = all?.[period];
  const last = data && data.length - 1;
  const shown = data?.[hover ?? last!];
  const max = data ? Math.max(...data.map((p) => p.count)) : 1;
  // Width is the point's index, height 0 to 100 with a little room at the top for the stroke. The
  // svg is absolute: in flow, its viewBox's ratio would set the box's height.
  const y = (count: number) => 100 - (count / max) * 96;
  const line = data?.map((p, i) => `${i ? "L" : "M"}${i},${y(p.count)}`).join("") ?? "";
  const label =
    !shown || hover === undefined
      ? "downloads"
      : period === "weekly"
        ? `week of ${day.format(new Date(shown.start))}`
        : month.format(new Date(shown.start));

  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <div
        className="relative h-10 sm:h-12"
        onPointerMove={(e) => {
          if (!data) return;
          const box = e.currentTarget.getBoundingClientRect();
          const i = Math.round(((e.clientX - box.left) / box.width) * last!);
          setHover(Math.min(Math.max(i, 0), last!));
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        {data && data.length > 1 ? (
          <>
            <svg
              viewBox={`0 0 ${last} 100`}
              preserveAspectRatio="none"
              className="absolute inset-0 size-full overflow-visible text-amber-500"
              role="img"
              aria-label={`${period === "weekly" ? "Weekly" : "Monthly"} downloads over the last year`}
            >
              <path d={`${line}L${last},100L0,100Z`} fill="currentColor" opacity="0.12" />
              <path
                d={line}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            {hover !== undefined && data[hover] && (
              <>
                <span
                  className="pointer-events-none absolute inset-y-0 w-px bg-zinc-300 dark:bg-zinc-700"
                  style={{ left: `${(hover / last!) * 100}%` }}
                />
                <span
                  className="pointer-events-none absolute size-2 -translate-1/2 rounded-full bg-amber-500 ring-2 ring-(--editor-bg)"
                  style={{ left: `${(hover / last!) * 100}%`, top: `${y(data[hover].count)}%` }}
                />
              </>
            )}
          </>
        ) : data ? (
          <p className="text-xs text-zinc-400">Not a full month yet.</p>
        ) : (
          <div className="size-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800/60" />
        )}
      </div>
      <div className="flex items-baseline gap-2 font-mono text-xs whitespace-nowrap text-zinc-500 tabular-nums">
        {shown && (
          <span className="font-medium text-zinc-800 dark:text-zinc-200">
            {number.format(shown.count)}
          </span>
        )}
        {label}
        <div className="ml-auto flex gap-2">
          {(["weekly", "monthly"] as const).map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={p === period}
              onClick={() => setPeriod((chosen = p))}
              className="text-zinc-400 hover:text-zinc-900 aria-pressed:font-medium aria-pressed:text-zinc-800 dark:text-zinc-500 dark:hover:text-zinc-100 dark:aria-pressed:text-zinc-200"
            >
              {p === "weekly" ? "week" : "month"}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
