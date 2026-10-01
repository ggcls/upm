// A registry package locked to a server that is none of its registries'.
import { sameIntegrity } from "./integrity.ts";
import type { Registry } from "./registry.ts";
import { integrityOf } from "./resolve.ts";
import type { ResolvedPackage } from "./resolve.ts";

/**
 * A lockfile may point a registry package at any server (`offRegistry`), which then decides
 * its bytes and the name inside them, and the integrity beside the url is the lockfile's too.
 * So before any byte is fetched or taken from the store, that integrity must be the one the
 * package's registry publishes for that name and version: then the bytes are the registry's,
 * whoever serves them, and a mirror still works. A kept document answers as for a pick.
 * Offline, without one, it is refused. A registry that gives only a sha1 `shasum` passes only a
 * lockfile naming that sha1 as its strongest hash, which the tarball is then checked against.
 */
export async function vouch(
  packages: ResolvedPackage[],
  open: (count: number) => Promise<Registry & { close(): void }>,
  offline?: boolean,
): Promise<void> {
  const registry = await open(packages.length);
  await Promise.all(
    packages.map(async ({ name, fetchName = name, version, resolved, integrity }) => {
      let host = resolved;
      try {
        host = new URL(resolved).origin;
      } catch {}
      const what = `${name}@${version} is locked to ${host}, not a registry in use`;
      const from = `${registry.baseFor(fetchName)} for ${fetchName}@${version}`;
      const found = await registry.pinned(fetchName, version);
      if (!found && offline) {
        throw fail(`${what}, and offline there is no kept document from ${from}`, "EOFFLINE");
      }
      if (!found) {
        const hint = "name its registry in .npmrc if it is one";
        throw fail(`${what}, and there is nothing at ${from}: ${hint}`, "ELOCK");
      }
      if (!sameIntegrity(integrityOf(found), integrity)) {
        throw fail(`${what}, and its integrity is not the one at ${from}`, "ELOCK");
      }
    }),
  ).finally(registry.close);
}

function fail(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}
