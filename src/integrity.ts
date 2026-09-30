// Subset of SSRI: parse, hash and stream-verify `<algorithm>-<base64>` strings.
import { createHasher, digest, fromBase64, fromHex, toBase64 } from "./runtime.ts";
import type { Algorithm } from "./runtime.ts";

export interface Parsed {
  algorithm: Algorithm;
  digest: string; // base64
}

/** Strongest first: a packument may offer several and we verify only the best. */
const ALGORITHMS = ["sha512", "sha384", "sha256", "sha1"] as const;
const SIZES: Record<Parsed["algorithm"], number> = { sha512: 64, sha384: 48, sha256: 32, sha1: 20 };
// `sha512-<base64>?opt=1` — SSRI allows trailing options, which carry no meaning here.
const ENTRY_RE = /^([a-z0-9]+)-([A-Za-z0-9+/=]+)(?:\?[\x21-\x7E]*)?$/;

/** Parse `sha512-<base64>`. Throws EINTEGRITY on anything else. */
export function parseIntegrity(value: string): Parsed {
  if (typeof value !== "string" || value.trim() === "") {
    throw fail(`Invalid integrity: expected a string, got ${JSON.stringify(value)}`);
  }
  let best: Parsed | undefined;
  for (const entry of value.trim().split(/\s+/)) {
    const match = ENTRY_RE.exec(entry);
    const algorithm = match?.[1] as Parsed["algorithm"] | undefined;
    if (!match || !algorithm || !ALGORITHMS.includes(algorithm)) continue;
    const raw = fromBase64(match[2] ?? "");
    if (raw.length !== SIZES[algorithm]) continue; // wrong length for its algorithm
    // Re-encode so padding and non-canonical input compare equal later.
    const parsed: Parsed = { algorithm, digest: toBase64(raw) };
    if (!best || ALGORITHMS.indexOf(algorithm) < ALGORITHMS.indexOf(best.algorithm)) best = parsed;
  }
  if (!best) throw fail(`Invalid integrity: no supported algorithm in "${value}"`);
  return best;
}

/** Two spellings of one integrity: the strongest hash each names is the same. */
export function sameIntegrity(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const [x, y] = [parseIntegrity(a), parseIntegrity(b)];
    return x.algorithm === y.algorithm && x.digest === y.digest;
  } catch {
    return false;
  }
}

/** Convert a legacy hex `dist.shasum` into `sha1-<base64>`. */
export function fromShasum(shasum: string): string {
  if (typeof shasum !== "string" || !/^[\da-f]{40}$/i.test(shasum.trim())) {
    throw fail(`Invalid shasum: expected 40 hex characters, got ${JSON.stringify(shasum)}`);
  }
  return `sha1-${toBase64(fromHex(shasum.trim()))}`;
}

/** Hash a buffer and return `<algorithm>-<base64>`. Many buffers: start them all, then await. */
export async function hashOf(data: Uint8Array, algorithm = "sha512"): Promise<string> {
  if (!ALGORITHMS.includes(algorithm as Algorithm)) {
    throw fail(`Unsupported algorithm "${algorithm}"`);
  }
  return `${algorithm}-${toBase64(await digest(algorithm as Algorithm, data))}`;
}

/**
 * Streaming verifier. `update` per chunk, `verify` at the end.
 * Throws EINTEGRITY with expected/actual in the message on mismatch.
 */
export function createVerifier(expected: string): {
  update(chunk: Uint8Array): void;
  verify(): Promise<void>;
} {
  const { algorithm, digest } = parseIntegrity(expected);
  const hash = createHasher(algorithm);
  let verdict: Promise<void> | undefined;
  return {
    update(chunk) {
      if (verdict) throw fail("Cannot update a verifier after verify()");
      hash.update(chunk);
    },
    verify() {
      // One verdict, handed to every caller: a second call must fail again, or a retry
      // wrapper would accept corrupt content.
      return (verdict ??= hash.digest().then((raw) => {
        const actual = toBase64(raw);
        if (actual !== digest) {
          throw fail(
            `Integrity check failed: expected ${algorithm}-${digest}, got ${algorithm}-${actual}`,
          );
        }
      }));
    },
  };
}

function fail(message: string): Error {
  return Object.assign(new Error(message), { code: "EINTEGRITY" });
}
