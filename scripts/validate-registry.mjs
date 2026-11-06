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
const CHANNELS = new Set(['state', 'action', 'stream']);
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;

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
    'locales',
    'permissions',
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

  if (plugin.banner !== undefined && !existsSync(join(root, plugin.banner))) {
    fail(`${at}.banner does not exist: ${plugin.banner}`);
  }

  if (plugin.locales !== undefined) {
    if (!Array.isArray(plugin.locales) || plugin.locales.length === 0) {
      fail(`${at}.locales must be a non-empty array`);
    } else {
      for (const locale of plugin.locales) {
        if (typeof locale !== 'string' || !LOCALE.test(locale)) {
          fail(`${at}.locales has an invalid tag: ${JSON.stringify(locale)}`);
        }
      }

      if (!plugin.locales.includes('en')) {
        fail(`${at}.locales must include "en", the fallback of every plugin`);
      }
    }
  }

  if (plugin.permissions !== undefined) {
    if (typeof plugin.permissions !== 'object' || plugin.permissions === null) {
      fail(`${at}.permissions must be an object`);
    } else {
      const channels = plugin.permissions.channels;

      if (channels !== undefined) {
        if (!Array.isArray(channels)) {
          fail(`${at}.permissions.channels must be an array`);
        } else {
          for (const channel of channels) {
            if (!CHANNELS.has(channel)) {
              fail(`${at}.permissions.channels has an unknown value: ${channel}`);
            }
          }
        }
      }

      if (plugin.permissions.frame !== undefined && !Array.isArray(plugin.permissions.frame)) {
        fail(`${at}.permissions.frame must be an array`);
      }
    }
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

      // The registry is generated from the manifest: a difference means the
      // bundler was not run after the manifest changed, and the store would
      // show a permission the build never asked for.
      const locales = Array.isArray(manifest.locales) ? manifest.locales : [];

      if (!locales.includes('en')) {
        fail(`plugins/${plugin.slug}/plugin.json locales must include "en"`);
      }

      if (!Array.isArray(manifest.permissions?.channels)) {
        fail(`plugins/${plugin.slug}/plugin.json needs permissions.channels`);
      }

      if (!sameList(locales, plugin.locales ?? [])) {
        fail(`${at}.locales does not match plugins/${plugin.slug}/plugin.json`);
      }

      const channels = Array.isArray(manifest.permissions?.channels)
        ? manifest.permissions.channels
        : [];
      const registryChannels = Array.isArray(plugin.permissions?.channels)
        ? plugin.permissions.channels
        : [];

      if (!sameList(channels, registryChannels)) {
        fail(`${at}.permissions.channels does not match plugins/${plugin.slug}/plugin.json`);
      }

      const capabilities = Array.isArray(manifest.capabilities)
        ? manifest.capabilities
        : [];

      if (!sameList(capabilities, plugin.capabilities)) {
        fail(`${at}.capabilities does not match plugins/${plugin.slug}/plugin.json`);
      }
    } catch (error) {
      fail(`plugins/${plugin.slug}/plugin.json is not valid JSON: ${error.message}`);
    }
  }
}

/** Order-insensitive comparison of two lists of strings. */
function sameList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;

  const expected = [...left].sort();
  const actual = [...right].sort();

  return expected.every((value, index) => value === actual[index]);
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`registry: ${problem}`);
  }

  process.exit(1);
}

console.log(`registry: ${plugins.length} plugin(s), ok`);
