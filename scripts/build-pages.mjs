#!/usr/bin/env node
// Builds the static site for GitHub Pages in _site/
//
// For every plugin in registry.json:
// - If plugins/<slug>/dist exists locally, copies it directly.
// - Otherwise downloads the release bundle from GitHub Releases and unzips it.
// - Copies files into:
//     _site/<slug>/<version>/
//     _site/<slug>/
//     _site/plugins/<slug>/dist/
// - Copies store assets (icon, banner) into:
//     _site/<slug>/
//     _site/plugins/<slug>/store/
// - Creates _site/.nojekyll and a minimal _site/index.html

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteDir = join(root, '_site');
const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));
const plugins = Array.isArray(registry.plugins) ? registry.plugins : [];

console.log(`Building GitHub Pages site in ${siteDir} for ${plugins.length} plugin(s)...`);

// 1. Prepare clean _site directory
rmSync(siteDir, { recursive: true, force: true });
mkdirSync(siteDir, { recursive: true });
writeFileSync(join(siteDir, '.nojekyll'), '');

const tempDir = mkdtempSync(join(tmpdir(), 'novyse-pages-'));

try {
  for (const plugin of plugins) {
    const { slug, version, tag, bundle } = plugin;
    console.log(`\nProcessing ${slug}@${version} (tag: ${tag})...`);

    const pluginDir = join(root, 'plugins', slug);
    const localDist = join(pluginDir, 'dist');
    let sourceDir = null;

    if (existsSync(join(localDist, 'index.html')) && existsSync(join(localDist, 'manifest.json'))) {
      console.log(`  using local dist from ${localDist}`);
      sourceDir = localDist;
    } else {
      console.log(`  downloading release bundle ${bundle} for ${tag}...`);
      const downloadDir = join(tempDir, slug);
      mkdirSync(downloadDir, { recursive: true });

      try {
        execSync(`gh release download "${tag}" -p "${bundle}" -D "${downloadDir}" --clobber`, {
          cwd: root,
          stdio: 'inherit',
        });
        const zipFile = join(downloadDir, bundle);
        const extractDir = join(downloadDir, 'extracted');
        mkdirSync(extractDir, { recursive: true });
        execSync(`unzip -q -o "${zipFile}" -d "${extractDir}"`);
        sourceDir = extractDir;
      } catch (err) {
        console.warn(`  WARNING: failed to download bundle for ${tag}: ${err.message}`);
        // Fallback: try building plugin locally if package.json exists
        if (existsSync(join(pluginDir, 'package.json'))) {
          console.log(`  attempting local build for ${slug}...`);
          execSync('npm ci || npm install', { cwd: pluginDir, stdio: 'inherit' });
          execSync('npm run build', { cwd: pluginDir, stdio: 'inherit' });
          if (existsSync(join(localDist, 'index.html'))) {
            sourceDir = localDist;
          }
        }
      }
    }

    if (!sourceDir) {
      console.error(`  ERROR: no distribution files available for ${slug}`);
      continue;
    }

    // Target paths
    const versionDir = join(siteDir, slug, version);
    const latestDir = join(siteDir, slug);
    const legacyDistDir = join(siteDir, 'plugins', slug, 'dist');

    for (const dir of [versionDir, latestDir, legacyDistDir]) {
      mkdirSync(dir, { recursive: true });
      cpSync(sourceDir, dir, { recursive: true });
    }

    // Copy store assets (icon, banner)
    const storeDir = join(pluginDir, 'store');
    if (existsSync(storeDir)) {
      const siteStoreDir = join(siteDir, 'plugins', slug, 'store');
      mkdirSync(siteStoreDir, { recursive: true });

      for (const asset of ['icon.png', 'banner.png']) {
        const assetSrc = join(storeDir, asset);
        if (existsSync(assetSrc)) {
          cpSync(assetSrc, join(latestDir, asset));
          cpSync(assetSrc, join(versionDir, asset));
          cpSync(assetSrc, join(siteStoreDir, asset));
        }
      }
    }

    console.log(`  ✓ deployed to ${slug}/${version}/, ${slug}/, and plugins/${slug}/dist/`);
  }

  // Generate simple root landing index.html
  const pluginCards = plugins
    .map(
      (p) => `
    <div style="border: 1px solid #333; border-radius: 8px; padding: 16px; margin: 12px 0;">
      <h2 style="margin: 0 0 8px 0;">${p.name} <small style="font-size: 0.6em; opacity: 0.7;">v${p.version}</small></h2>
      <p style="margin: 0 0 12px 0;">${p.description}</p>
      <div style="font-size: 0.9em; font-family: monospace;">
        <div><strong>Entry:</strong> <a href="${p.slug}/${p.version}/index.html">${p.slug}/${p.version}/index.html</a></div>
        <div><strong>Manifest:</strong> <a href="${p.slug}/${p.version}/manifest.json">${p.slug}/${p.version}/manifest.json</a></div>
        <div><strong>Bundle:</strong> <a href="https://github.com/Novyse/plugins/releases/download/${p.tag}/${p.bundle}">${p.bundle}</a></div>
      </div>
    </div>`
    )
    .join('\n');

  const rootHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Novyse Plugins</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f1117; color: #e6edf3; max-width: 800px; margin: 40px auto; padding: 0 20px; line-height: 1.5; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Novyse Plugins Library</h1>
  <p>Static distribution and web builds of official Novyse voice room activities.</p>
  ${pluginCards}
</body>
</html>
`;

  writeFileSync(join(siteDir, 'index.html'), rootHtml);
  console.log(`\n✓ GitHub Pages site successfully generated at ${siteDir}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
