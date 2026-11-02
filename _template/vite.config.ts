import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const here = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(readFileSync(resolve(here, 'plugin.json'), 'utf8')) as {
  id: string;
  name: string;
  description?: string;
  version: string;
  capabilities?: string[];
  author?: string;
};

/**
 * Writes `dist/manifest.json` from `plugin.json`.
 *
 * The manifest is the only metadata the client reads from the bundle, and it
 * must agree with the registry: same id, same version, same capabilities.
 */
function manifest(): Plugin {
  return {
    name: 'novyse-manifest',
    apply: 'build',
    closeBundle() {
      const dist = resolve(here, 'dist');
      mkdirSync(dist, { recursive: true });

      const document = {
        schemaVersion: 1,
        id: source.id,
        name: source.name,
        ...(source.description ? { description: source.description } : {}),
        version: source.version,
        entry: 'index.html',
        capabilities: source.capabilities ?? [],
        ...(source.author ? { author: source.author } : {}),
      };

      writeFileSync(
        resolve(dist, 'manifest.json'),
        `${JSON.stringify(document, null, 2)}\n`,
      );
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), viteSingleFile(), manifest()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  optimizeDeps: {
    // Linked workspace package: transform its TS source instead of pre-bundling it.
    exclude: ['@novyse/app-sdk'],
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    // Everything is inlined: the client mounts one file, no sub-resources.
    assetsInlineLimit: 100_000_000,
  },
});
