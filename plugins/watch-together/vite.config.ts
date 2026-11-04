import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  permissions?: { frame?: string[] };
  author?: string;
};

/** Writes `dist/manifest.json` from `plugin.json`, so the two cannot diverge. */
function manifest(): Plugin {
  return {
    name: 'novyse-manifest',
    apply: 'build',
    closeBundle() {
      const dist = resolve(here, 'dist');
      mkdirSync(dist, { recursive: true });

      writeFileSync(
        resolve(dist, 'manifest.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: source.id,
            name: source.name,
            ...(source.description ? { description: source.description } : {}),
            version: source.version,
            entry: 'index.html',
            capabilities: source.capabilities ?? [],
            ...(source.author ? { author: source.author } : {}),
            ...(source.permissions ? { permissions: source.permissions } : {}),
          },
          null,
          2,
        )}\n`,
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
    exclude: ['@novyse/app-sdk'],
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
  },
});
