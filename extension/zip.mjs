/**
 * Packs `extension/dist` into `public/autorag-extension.zip`.
 *
 *   pnpm ext && pnpm ext:zip
 *
 * A web page cannot install an extension on click — inline installation was
 * removed in Chrome 71 — so the download is a zip plus three lines of
 * instructions. `output: 'export'` copies `public/` into `out/`, which is what
 * gets deployed, so the file lands at `/autorag-extension.zip`.
 *
 * ## Why it is not committed
 *
 * The zip is a build output, and a 25MB binary in git would be re-committed on
 * every extension change and stale the moment someone forgot. It is built during
 * the deploy instead, from the same `extension/dist` the checks ran against, so
 * the thing people download is the thing that was tested. `.gitignore` keeps it
 * out of the tree.
 *
 * ## Why the ZIP is written by hand
 *
 * The alternative was shelling out to `zip`, which makes the deploy depend on a
 * binary in the build image, or adding an archiver dependency for one file. The
 * format is genuinely small: a local header per file, a central directory, and
 * an end record. `zlib` supplies both the deflate and the CRC, so this is
 * bookkeeping rather than compression.
 *
 * No zip64. It applies over 4GB and this is two orders of magnitude short.
 */

import { crc32, deflateRawSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, 'dist');
const target = resolve(here, '..', 'public', 'autorag-extension.zip');

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

let files;
try {
  files = walk(dist).sort();
} catch {
  throw new Error(`no build at ${dist} — run \`pnpm ext\` first`);
}

/*
 * A dist without a manifest is not an extension, and Chrome's error for that
 * ("Manifest file is missing or unreadable") sends people looking at the zip
 * tool rather than at the build that produced an empty directory.
 */
if (!files.some((f) => relative(dist, f) === 'manifest.json')) {
  throw new Error(`${dist} has no manifest.json — the build did not complete`);
}

/*
 * A fixed timestamp rather than mtime, so two builds of identical bytes produce
 * an identical zip. The DOS date format cannot represent anything before 1980,
 * so that is the epoch here.
 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // 1980-01-01

const local = [];
const central = [];
let offset = 0;

for (const file of files) {
  // Zip entries are always forward-slashed, whatever the platform wrote.
  const name = Buffer.from(relative(dist, file).split(sep).join('/'), 'utf8');
  const body = readFileSync(file);
  const deflated = deflateRawSync(body, { level: 9 });

  /*
   * Store when deflating made it bigger. Already-compressed payloads — the
   * .wasm blobs are most of this archive — can inflate by a few bytes, and an
   * entry that claims method 8 while being larger than its input is legal but
   * pointlessly slower to read.
   */
  const stored = deflated.length >= body.length;
  const payload = stored ? body : deflated;
  const method = stored ? 0 : 8;
  const sum = crc32(body);

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // local file header signature
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(sum, 14);
  header.writeUInt32LE(payload.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  local.push(header, name, payload);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); // central directory header signature
  entry.writeUInt16LE(20, 4); // version made by
  entry.writeUInt16LE(20, 6); // version needed
  entry.writeUInt16LE(0, 8); // flags
  entry.writeUInt16LE(method, 10);
  entry.writeUInt16LE(DOS_TIME, 12);
  entry.writeUInt16LE(DOS_DATE, 14);
  entry.writeUInt32LE(sum, 16);
  entry.writeUInt32LE(payload.length, 20);
  entry.writeUInt32LE(body.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt16LE(0, 30); // extra field length
  entry.writeUInt16LE(0, 32); // comment length
  entry.writeUInt16LE(0, 34); // disk number
  entry.writeUInt16LE(0, 36); // internal attributes
  // External attributes: regular file, 644, in the high 16 bits. Multiplied
  // rather than shifted — `<<` is a signed 32-bit operator and 0o100644 << 16
  // overflows to a negative, which writeUInt32LE rejects.
  entry.writeUInt32LE(0o100644 * 0x10000, 38);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);

  offset += header.length + name.length + payload.length;
}

const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); // end of central directory signature
end.writeUInt16LE(0, 4); // this disk
end.writeUInt16LE(0, 6); // disk with the directory
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20); // comment length

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, Buffer.concat([...local, directory, end]));

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
const raw = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(
  `packed ${files.length} files, ${mb(raw)} → ${mb(statSync(target).size)} at ${target}`,
);
