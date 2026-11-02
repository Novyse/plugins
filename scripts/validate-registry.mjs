#!/usr/bin/env node
// Validates registry.json and the files it references.
//
// The checks are the contract of the repository: a tag is <slug>@<version>,
// the bundle is <slug>-bundle.zip, the entry point exists in the tree.
// No dependency on purpose: this must run on a blank runner.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SLUG = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIN_APP = /^[0-9]+\.[0-9]+\.[0-9]+-[0-9]{8}\.[0-9]+$/;
const CAPABILITIES = new Set(['stream', 'fullscreen', 'network']);

const problems = [];
const fail = (message) => problems.push(message);

let registry;

try {
  registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
} catch (error) {
  console.error(`registry.json: ${error.message}`);
  process.exit(1);
}

if (registry.schemaVersion !== 1) {
  fail(`schemaVersion must be 1, got ${JSON.stringify(registry.schemaVersion)}`);
}

if (typeof registry.library !== 'string' || registry.library.length === 0) {
  fail('library must be a non-empty string');
}

if (!Array.isArray(registry.plugins)) {
  fail('plugins must be an array');
}

const plugins = Array.isArray(registry.plugins) ? registry.plugins : [];
const seen = new Set();

for (const [index, plugin] of plugins.entries()) {
  const at = `plugins[${index}]`;

  if (typeof plugin !== 'object' || plugin === null) {
    fail(`${at} must be an object`);
    continue;
  }

  for (const field of [
    'slug',
    'name',
    'description',
    'version',
    'tag',
    'entry',
    'bundle',
    'sha256',
    'sizeBytes',
    'capabilities',
  ]) {
    if (plugin[field] === undefined) {
      fail(`${at}.${field} is required`);
    }
  }

  if (!SLUG.test(plugin.slug ?? '')) {
    fail(`${at}.slug is not a valid slug: ${JSON.stringify(plugin.slug)}`);
    continue;
  }

  if (seen.has(plugin.slug)) {
    fail(`${at}.slug is duplicated: ${plugin.slug}`);
  }

  seen.add(plugin.slug);

  if (!VERSION.test(plugin.version ?? '')) {
    fail(`${at}.version is not semver: ${JSON.stringify(plugin.version)}`);
  }

  const expectedTag = `${plugin.slug}@${plugin.version}`;

  if (plugin.tag !== expectedTag) {
    fail(`${at}.tag must be ${expectedTag}, got ${JSON.stringify(plugin.tag)}`);
  }

  if (plugin.entry !== `plugins/${plugin.slug}/dist/index.html`) {
    fail(`${at}.entry must be plugins/${plugin.slug}/dist/index.html`);
  } else if (!existsSync(join(root, plugin.entry))) {
    fail(`${at}.entry does not exist: ${plugin.entry}`);
  }

  if (plugin.icon !== undefined && !existsSync(join(root, plugin.icon))) {
    fail(`${at}.icon does not exist: ${plugin.icon}`);
  }

  if (plugin.bundle !== `${plugin.slug}-bundle.zip`) {
    fail(`${at}.bundle must be ${plugin.slug}-bundle.zip`);
  }

  if (!SHA256.test(plugin.sha256 ?? '')) {
    fail(`${at}.sha256 must be 64 lowercase hex characters`);
  }

  if (!Number.isInteger(plugin.sizeBytes) || plugin.sizeBytes <= 0) {
    fail(`${at}.sizeBytes must be a positive integer`);
  }

  if (plugin.minAppVersion !== undefined && !MIN_APP.test(plugin.minAppVersion)) {
    fail(`${at}.minAppVersion must look like 2.4.0-20261102.0`);
  }

  if (!Array.isArray(plugin.capabilities)) {
    fail(`${at}.capabilities must be an array`);
  } else {
    for (const capability of plugin.capabilities) {
      if (!CAPABILITIES.has(capability)) {
        fail(`${at}.capabilities has an unknown value: ${capability}`);
      }
    }
  }

  const source = join(root, 'plugins', plugin.slug, 'plugin.json');

  if (!existsSync(source)) {
    fail(`${at} has no plugins/${plugin.slug}/plugin.json`);
  } else {
    try {
      const manifest = JSON.parse(readFileSync(source, 'utf8'));

      if (manifest.id !== plugin.slug) {
        fail(`${at}.slug does not match plugins/${plugin.slug}/plugin.json id`);
      }

      if (manifest.version !== plugin.version) {
        fail(
          `${at}.version ${plugin.version} does not match plugins/${plugin.slug}/plugin.json ${manifest.version}`,
        );
      }
    } catch (error) {
      fail(`plugins/${plugin.slug}/plugin.json is not valid JSON: ${error.message}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`registry: ${problem}`);
  }

  process.exit(1);
}

console.log(`registry: ${plugins.length} plugin(s), ok`);
