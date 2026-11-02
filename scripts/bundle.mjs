#!/usr/bin/env node
// Builds <slug>-bundle.zip from plugins/<slug>/dist and keeps registry.json in
// sync with it.
//
// The zip is written here, byte for byte, by a store-only writer with fixed
// timestamps and sorted entries: the same dist produces the same archive on
// every machine and in CI. That is what makes the `sha256` in registry.json
// meaningful — the native clients verify the download against it, so a zip
// created by `zip(1)` (which embeds mtimes) would never match twice.
//
// Usage:
//   node scripts/bundle.mjs <slug>                    build and print
//   node scripts/bundle.mjs <slug> --update-registry   build and write the entry
//   node scripts/bundle.mjs <slug> --check-registry    build and fail on mismatch
//
// No dependency on purpose: this must run on a blank runner.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith('--')));
const slug = args.find((argument) => !argument.startsWith('--'));

if (!slug || !SLUG.test(slug)) {
  console.error('usage: node scripts/bundle.mjs <slug> [--update-registry|--check-registry]');
  process.exit(1);
}

const pluginDir = join(root, 'plugins', slug);
const distDir = join(pluginDir, 'dist');

for (const required of ['index.html', 'manifest.json']) {
  if (!existsSync(join(distDir, required))) {
    console.error(`missing ${relative(root, join(distDir, required))}: run npm run build first`);
    process.exit(1);
  }
}

const source = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'));
const files = walk(distDir);
const archive = buildZip(files);
const archiveName = `${slug}-bundle.zip`;
const archivePath = join(root, archiveName);

writeFileSync(archivePath, archive);

const sha256 = createHash('sha256').update(archive).digest('hex');
const sizeBytes = archive.length;

const iconPath = join(distDir, 'icon.png');
const entry = {
  slug,
  name: source.name,
  description: source.description,
  version: source.version,
  tag: `${slug}@${source.version}`,
  ...(existsSync(iconPath) ? { icon: `plugins/${slug}/dist/icon.png` } : {}),
  entry: `plugins/${slug}/dist/index.html`,
  bundle: archiveName,
  sha256,
  sizeBytes,
  ...(source.minAppVersion ? { minAppVersion: source.minAppVersion } : {}),
  capabilities: source.capabilities ?? [],
};

const registryPath = join(root, 'registry.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const plugins = Array.isArray(registry.plugins) ? registry.plugins : [];
const index = plugins.findIndex((plugin) => plugin.slug === slug);

if (flags.has('--check-registry')) {
  if (index < 0) {
    console.error(`registry.json has no entry for ${slug}`);
    process.exit(1);
  }

  const committed = plugins[index];
  const problems = [];

  if (committed.sha256 !== sha256) {
    problems.push(`sha256: registry ${committed.sha256} != archive ${sha256}`);
  }

  if (committed.sizeBytes !== sizeBytes) {
    problems.push(`sizeBytes: registry ${committed.sizeBytes} != archive ${sizeBytes}`);
  }

  if (committed.version !== source.version) {
    problems.push(`version: registry ${committed.version} != plugin.json ${source.version}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`bundle: ${problem}`);
    console.error('run: node scripts/bundle.mjs ' + slug + ' --update-registry');
    process.exit(1);
  }

  console.log(`bundle: ${archiveName} matches registry.json (${sizeBytes} bytes)`);
} else if (flags.has('--update-registry')) {
  if (index >= 0) plugins[index] = entry;
  else plugins.push(entry);

  registry.plugins = plugins;

  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  console.log(`bundle: ${archiveName}`);
  console.log(`bundle: registry.json updated (${index >= 0 ? 'replaced' : 'added'} ${slug})`);
} else {
  console.log(`bundle: ${archiveName}`);
  console.log(`bundle: ${JSON.stringify(entry, null, 2)}`);
}

console.log(`archive: ${archivePath}`);
console.log(`sha256: ${sha256}`);
console.log(`sizeBytes: ${sizeBytes}`);

/** Every file of `dir`, as `{ name, data }` with POSIX names, sorted. */
function walk(dir) {
  const files = [];

  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      files.push(...walk(path));
      continue;
    }

    if (!stats.isFile()) continue;

    files.push({
      name: relative(distDir, path).split(sep).join('/'),
      data: readFileSync(path),
    });
  }

  return files;
}

/** A deterministic, store-only zip: fixed date, no extra fields, no mtimes. */
function buildZip(files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const size = file.data.length;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed to extract
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(0, 8); // stored, no compression
    header.writeUInt16LE(0, 10); // time: 00:00
    header.writeUInt16LE(0x0021, 12); // date: 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // no extra field

    local.push(header, name, file.data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4); // version made by
    directory.writeUInt16LE(20, 6); // version needed
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(size, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30); // extra
    directory.writeUInt16LE(0, 32); // comment
    directory.writeUInt16LE(0, 34); // disk
    directory.writeUInt16LE(0, 36); // internal attributes
    directory.writeUInt32LE(0, 38); // external attributes
    directory.writeUInt32LE(offset, 42);

    central.push(directory, name);

    offset += header.length + name.length + size;
  }

  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...local, ...central, end]);
}

// The table is memoised on the function, not in a module-level binding: this
// file assembles the archive before it reaches the bottom of the module, and a
// `let` up here would be in its temporal dead zone.
function crc32(data) {
  crc32.table ??= buildCrcTable();

  let crc = -1;

  for (let index = 0; index < data.length; index += 1) {
    crc = crc32.table[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ -1) >>> 0;
}

function buildCrcTable() {
  const table = new Int32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value;
  }

  return table;
}
