import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVerifier,
  fromShasum,
  hashOf,
  parseIntegrity,
  sameIntegrity,
} from "../src/integrity.ts";

const data = Buffer.from("upm");
const digest = (algorithm: string) => createHash(algorithm).update(data).digest("base64");
const sha512 = `sha512-${digest("sha512")}`;
const sha1 = `sha1-${digest("sha1")}`;

describe("parseIntegrity", () => {
  it("parses a single entry", () => {
    expect(parseIntegrity(sha512)).toEqual({ algorithm: "sha512", digest: digest("sha512") });
  });

  it("picks the strongest of several entries", () => {
    const mixed = `${sha1} sha256-${digest("sha256")} ${sha512}`;
    expect(parseIntegrity(mixed).algorithm).toBe("sha512");
    expect(parseIntegrity(`${sha1} sha384-${digest("sha384")}`).algorithm).toBe("sha384");
    expect(parseIntegrity(`  ${sha1}\t${sha1}  `).algorithm).toBe("sha1");
  });

  it("ignores unknown algorithms and trailing options", () => {
    expect(parseIntegrity(`sha3-abcd ${sha512}?foo=bar`).algorithm).toBe("sha512");
  });

  it("throws EINTEGRITY on junk", () => {
    for (const bad of [
      "",
      "   ",
      "sha512",
      "not-integrity",
      "md5-abc",
      "sha512-!!!",
      sha512.slice(0, -4),
    ]) {
      expect(() => parseIntegrity(bad)).toThrowError(
        expect.objectContaining({ code: "EINTEGRITY" }),
      );
    }
    // @ts-expect-error deliberately wrong type
    expect(() => parseIntegrity(undefined)).toThrowError(
      expect.objectContaining({ code: "EINTEGRITY" }),
    );
  });

  it("normalizes the digest so padding does not matter", () => {
    const unpadded = sha512.replace(/=+$/, "");
    expect(parseIntegrity(unpadded).digest).toBe(digest("sha512"));
  });
});

describe("sameIntegrity", () => {
  it("compares the strongest hash, however the string is spelled", () => {
    expect(sameIntegrity(sha512, sha512)).toBe(true);
    expect(sameIntegrity(`${sha1} ${sha512}`, `  ${sha512}?x=1`)).toBe(true);
    expect(sameIntegrity(sha512, sha1)).toBe(false);
    expect(
      sameIntegrity(sha512, `sha512-${createHash("sha512").update("x").digest("base64")}`),
    ).toBe(false);
    expect(sameIntegrity(sha512, "garbage")).toBe(false);
  });
});

describe("fromShasum", () => {
  it("converts hex to sha1 base64", () => {
    const hex = createHash("sha1").update(data).digest("hex");
    expect(fromShasum(hex)).toBe(sha1);
    expect(fromShasum(hex.toUpperCase())).toBe(sha1);
  });

  it("throws EINTEGRITY on a bad shasum", () => {
    for (const bad of ["", "zz", "g".repeat(40), "ab".repeat(21)]) {
      expect(() => fromShasum(bad)).toThrowError(expect.objectContaining({ code: "EINTEGRITY" }));
    }
  });
});

describe("hashOf", () => {
  it("defaults to sha512", async () => {
    expect(await hashOf(data)).toBe(sha512);
    expect(await hashOf(data, "sha1")).toBe(sha1);
    expect(await hashOf(new Uint8Array(0))).toBe(`sha512-${createHash("sha512").digest("base64")}`);
  });

  it("round-trips through parseIntegrity", async () => {
    expect(parseIntegrity(await hashOf(data, "sha256")).algorithm).toBe("sha256");
  });

  it("rejects an unsupported algorithm", async () => {
    await expect(hashOf(data, "md5")).rejects.toThrowError(
      expect.objectContaining({ code: "EINTEGRITY" }),
    );
  });
});

describe("createVerifier", () => {
  it("accepts a matching stream", async () => {
    const verifier = createVerifier(sha512);
    verifier.update(data.subarray(0, 3));
    verifier.update(data.subarray(3));
    await expect(verifier.verify()).resolves.toBeUndefined();
  });

  it("verifies against the strongest offered algorithm", async () => {
    const verifier = createVerifier(`${sha1} ${sha512}`);
    verifier.update(data);
    await expect(verifier.verify()).resolves.toBeUndefined();
  });

  it("throws EINTEGRITY naming expected and actual", async () => {
    const verifier = createVerifier(sha512);
    verifier.update(Buffer.from("tampered"));
    const thrown = await verifier.verify().then(
      () => undefined,
      (error: Error) => error,
    );
    expect(thrown).toMatchObject({ code: "EINTEGRITY" });
    expect(thrown?.message).toContain(sha512);
    expect(thrown?.message).toContain(await hashOf(Buffer.from("tampered")));
  });

  it("rejects an empty stream that should have had bytes", async () => {
    const verifier = createVerifier(sha512);
    await expect(verifier.verify()).rejects.toThrowError(
      expect.objectContaining({ code: "EINTEGRITY" }),
    );
  });

  it("refuses updates after verify and is idempotent", async () => {
    const verifier = createVerifier(sha512);
    verifier.update(data);
    const first = verifier.verify();
    expect(verifier.verify()).toBe(first); // one verdict, not one per call
    await first;
    expect(() => verifier.update(data)).toThrowError(
      expect.objectContaining({ code: "EINTEGRITY" }),
    );
  });

  it("keeps failing on a second verify", async () => {
    const verifier = createVerifier(await hashOf(Buffer.from("right")));
    verifier.update(Buffer.from("wrong"));

    await expect(verifier.verify()).rejects.toThrow(/Integrity check failed/);
    // A retry wrapper calling verify() again must not be told the content is fine.
    await expect(verifier.verify()).rejects.toThrow(/Integrity check failed/);
  });
});
