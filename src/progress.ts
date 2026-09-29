// The progress line `cli.ts` draws on a terminal. Loaded only when one can be drawn.
import type { Progress } from "./api.ts";

/** What each phase last reported. */
export type Seen = Partial<Record<Progress["phase"], Progress>>;

export interface Bar {
  hear: (progress: Progress) => void;
  /** Takes the line off the screen; the next tick draws it again. */
  clear: () => void;
  stop: () => void;
}

const WIDTH = 20;
/** About 30 frames a second. */
const TICK = 33;

/**
 * What it hears is kept, and drawn on each tick it changed. Never in CI or on a terminal that
 * cannot move the cursor.
 */
export function startBar(
  stream: NodeJS.WriteStream,
  gray: (text: string) => string,
  env: Record<string, string | undefined> = globalThis.process.env,
): Bar | undefined {
  if ((env.CI !== undefined && env.CI !== "false") || env.TERM === "dumb") return undefined;
  const osc = takesOsc(env);
  const seen: Seen = {};
  let shown = "";
  let reported = "";
  const draw = () => {
    const line = barLine(seen, (stream.columns || 80) - 1, gray);
    const report = osc ? oscProgress(fraction(seen)) : "";
    if (line === shown && report === reported) return;
    stream.write(`${report === reported ? "" : report}\r${line}\x1b[K`);
    shown = line;
    reported = report;
  };
  const timer = setInterval(draw, TICK).unref();
  const clear = () => {
    if (shown) stream.write("\r\x1b[K");
    shown = "";
  };
  const stop = () => {
    clearInterval(timer);
    clear();
    if (reported) stream.write(oscProgress(null));
    reported = "";
    globalThis.process.off("SIGINT", interrupted);
  };
  // Ctrl+C would leave the terminal's progress up; take it down, then die of the signal as before.
  const interrupted = () => {
    stop();
    globalThis.process.kill(globalThis.process.pid, "SIGINT");
  };
  if (osc) globalThis.process.once("SIGINT", interrupted);
  return { hear: (progress) => void (seen[progress.phase] = progress), clear, stop };
}

/**
 * Terminals known to show OSC 9;4 progress on their tab or taskbar. Others may take any OSC 9
 * as a desktop notification, so they get none.
 */
export function takesOsc(env: Record<string, string | undefined>): boolean {
  const program = env.TERM_PROGRAM;
  return (
    env.WT_SESSION !== undefined ||
    env.ConEmuANSI === "ON" ||
    program === "ghostty" ||
    program === "WezTerm" ||
    program === "vscode"
  );
}

/** OSC 9;4 for `done` from 0 to 1, busy with no known end while undefined, or off for null. */
export function oscProgress(done: number | undefined | null): string {
  const state = done === null ? "0" : done === undefined ? "3" : `1;${Math.floor(done * 100)}`;
  return `\x1b]9;4;${state}\x1b\\`;
}

/**
 * How full the bar is, 0 to 1, or undefined while resolving. Fetch and link each fill half,
 * each against its own total: they overlap, and the link finishes last.
 */
export function fraction({ fetch, link }: Seen): number | undefined {
  const linked = link ? part(link) : 0;
  return fetch ? (part(fetch) + linked) / 2 : link && linked;
}

/** A phase with nothing left to do is done. */
const part = ({ done, total }: Progress): number => (total! > 0 ? done / total! : 1);

/** Past `columns` the line would wrap and `\r` would redraw only its tail, so the bar goes first. */
export function barLine(seen: Seen, columns: number, gray = (text: string) => text): string {
  const { resolve, fetch, link } = seen;
  const done = fraction(seen);
  if (done === undefined)
    return resolve ? `resolving ${resolve.done} packages`.slice(0, columns) : "";
  const linked = link?.done ?? 0;
  const counts = fetch
    ? `${fetch.done}/${fetch.total} fetched, ${linked} linked`
    : `${linked}/${link!.total} linked`;
  if (counts.length + WIDTH + 1 > columns) return counts.slice(0, columns);
  const full = Math.min(WIDTH, Math.round(done * WIDTH));
  const rest = full < WIDTH ? gray("─".repeat(WIDTH - full)) : "";
  return `${"━".repeat(full)}${rest} ${counts}`;
}
