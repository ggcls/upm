// Locked versions held to the release cutoff by what their tarballs were served with. Its own
// module, loaded only by an install that downloaded one served as newer than the cutoff.
import type { Lockfile } from "./lock.ts";
import { globs } from "./registry.ts";
import { GROUPS } from "./resolve.ts";
import type { Resolution, RootManifest } from "./resolve.ts";
import { parse } from "./semver.ts";
import { parseDep } from "./spec.ts";

/** What `warnNewer` reads of an install's context. */
interface Install {
  log: (message: string, level: "warn") => void;
  config?: { releaseAgeExclude: string[] };
  /** What the install's resolve kept versions from, when it resolved. */
  prior?: Lockfile["packages"];
}

/**
 * A locked version is never picked, so the release cutoff never saw it: a lockfile edited, or
 * made under another cutoff, can pin one newer. Its tarball's `last-modified` (`newer`, by
 * integrity) says so as it is downloaded, at no request of its own; one already in the store
 * goes unchecked. Not a version the resolve picked, one a top pins exactly, or an excluded
 * name: the cutoff passes those. Nor one only newer packages depend on, as a build for each
 * platform is: their own pins explain it, and they are told or passed themselves.
 */
export function warnNewer(
  ctx: Install,
  newer: Map<string, number>,
  project: { manifest: RootManifest; workspaces: { manifest: RootManifest }[] },
  resolution: Resolution,
): void {
  const { prior } = ctx;
  const excluded = globs(ctx.config?.releaseAgeExclude ?? []);
  const exact = new Set<string>();
  for (const { manifest } of [project, ...project.workspaces]) {
    for (const group of GROUPS) {
      for (const [name, range] of Object.entries(manifest[group] ?? {})) {
        try {
          const spec = parseDep(name, range);
          if (spec.type === "version") exact.add(`${name}@${parse(spec.fetchSpec)?.version}`);
        } catch {} // not a registry spec
      }
    }
  }
  // What some top or older package depends on.
  const asked = new Set<string>();
  const edges = (deps: Record<string, string>) => {
    for (const [name, version] of Object.entries(deps)) asked.add(`${name}@${version}`);
  };
  edges(resolution.root.dependencies);
  for (const pkg of Object.values(resolution.packages)) {
    if (pkg.local === undefined && newer.has(pkg.integrity)) continue;
    edges(pkg.dependencies);
    edges(pkg.optionalDependencies ?? {});
  }
  const found: string[] = [];
  for (const [key, pkg] of Object.entries(resolution.packages)) {
    const at = newer.get(pkg.integrity);
    if (at === undefined || pkg.source !== undefined || exact.has(key) || !asked.has(key)) continue;
    if (prior && prior[key]?.integrity !== pkg.integrity) continue;
    if (!excluded(pkg.fetchName ?? pkg.name)) found.push(`${key} (${new Date(at).toISOString()})`);
  }
  if (found.length === 0) return;
  // A lock made with no cutoff can hold hundreds: one line, not a screen.
  const more = found.length > 10 ? ` and ${found.length - 10} more` : "";
  ctx.log(
    `locked versions published after the release cutoff, as their tarballs' last-modified says: ${found.slice(0, 10).join(", ")}${more} (min-release-age; see min-release-age-exclude)`,
    "warn",
  );
}
