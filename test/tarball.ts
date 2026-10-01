// A gzipped ustar tarball, shaped the way the registry serves one. Shared because four test
// files need a package to install and none of them care how a tar header is laid out.
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

export interface Entry {
  path: string;
  data: string | Uint8Array;
  mode?: number;
}

/** One ustar header block plus padded contents. */
function block(path: string, data: Uint8Array, mode: number): Uint8Array {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8);
  header.write("0000000\0", 108, 8);
  header.write("0000000\0", 116, 8);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
  header.write("00000000000\0", 136, 12);
  header.write("        ", 148, 8); // checksum is computed over spaces
  header.write("0", 156, 1); // regular file
  header.write("ustar\0", 257, 6);
  header.write("00", 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const pad = (512 - (data.length % 512)) % 512;
  return Buffer.concat([header, data, Buffer.alloc(pad)]);
}

/** Every entry under `package/`, as npm publishes them. */
export function makeTarball(entries: Entry[]): Uint8Array {
  const blocks = entries.map((entry) =>
    block(`package/${entry.path}`, Buffer.from(entry.data), entry.mode ?? 0o644),
  );
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
