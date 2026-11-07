import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Excalidraw ships its text fonts as separate woff2 subsets and builds a
 * `FontFace` per subset at runtime from `EXCALIDRAW_ASSET_PATH`, with `esm.sh`
 * as a fallback origin. A plugin bundle is one file fetched from
 * `raw.githubusercontent.com` and mounted in a sandbox, so those files do not
 * exist at any URL the document could use: they have to travel inside it.
 *
 * `src/assets.ts` turns this map into the sources Excalidraw asks for, and drops
 * the ones that are not here instead of letting the browser try the CDN.
 */
const FONT_DIR = resolve(
  here,
  'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
);

/**
 * Left out on purpose: one family, 13 MB, CJK glyphs only. The board falls back
 * to the system font for those characters and the bundle stays downloadable.
 */
const SKIPPED_FAMILIES = new Set(['Xiaolai']);

const source = JSON.parse(readFileSync(resolve(here, 'plugin.json'), 'utf8')) as {
  id: string;
  name: string;
  description?: string;
  version: string;
  capabilities?: string[];
  locales?: string[];
  permissions?: { channels?: string[]; frame?: string[] };
  author?: { name: string; url?: string };
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
            ...(source.locales ? { locales: source.locales } : {}),
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

/**
 * Keeps the language files of the plugin's own locales, drops the other ~60.
 *
 * The package imports every language statically (`()=>import("./locales/it-IT-
 * HASH.js")` inside one map), so a scripted build would carry all of them: 1.7 MB
 * of strings for languages this plugin does not offer. The map entry is never
 * called for a language the plugin does not pass as `langCode`, so a loader that
 * rejects is enough to let Rollup drop the module.
 */
function bundledLocales(): Plugin {
  const keep = /^\/(en|it)(-[A-Z]{2})?$/;
  let kept = 0;
  let dropped = 0;

  return {
    name: 'novyse-locales',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw') || !id.endsWith('.js')) return null;
      if (!code.includes('./locales/')) return null;

      const next = code.replace(
        /\(\)\s*=>\s*import\("(\.\/locales\/([a-zA-Z]+(?:-[A-Z]{2})?)-[A-Z0-9]+\.js)"\)/g,
        (match, _specifier: string, language: string) => {
          if (keep.test(`/${language}`)) {
            kept += 1;
            return match;
          }

          dropped += 1;

          return '()=>Promise.reject(new Error("language not bundled"))';
        },
      );

      return next === code ? null : next;
    },
    buildEnd() {
      if (dropped > 0) {
        console.log(`locales: kept ${kept}, dropped ${dropped}`);
        return;
      }

      console.warn(
        'locales: nothing dropped, the package changed shape: the bundle carries every language',
      );
    },
  };
}

/**
 * `virtual:excalidraw-fonts`: every woff2 subset of the package, keyed by the
 * path Excalidraw builds, as a data URL.
 */
function offlineFonts(): Plugin {
  const virtualId = 'virtual:excalidraw-fonts';
  const resolvedId = `\0${virtualId}`;
  let module: string | null = null;

  const build = (): string => {
    const fonts: Record<string, string> = {};

    for (const file of walk(FONT_DIR)) {
      if (!file.endsWith('.woff2')) continue;
      if (SKIPPED_FAMILIES.has(file.split('/')[0])) continue;

      fonts[file] = `data:font/woff2;base64,${readFileSync(join(FONT_DIR, file)).toString('base64')}`;
    }

    return `export default ${JSON.stringify(fonts)};\n`;
  };

  return {
    name: 'novyse-offline-fonts',
    resolveId: (id) => (id === virtualId ? resolvedId : null),
    load: (id) => {
      if (id !== resolvedId) return null;

      module ??= build();

      return module;
    },
  };
}

/** Every file under `dir`, as POSIX paths relative to `root`. */
function walk(dir: string, root = dir): string[] {
  const files: string[] = [];

  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      files.push(...walk(path, root));
      continue;
    }

    files.push(relative(root, path).split(sep).join('/'));
  }

  return files;
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), bundledLocales(), offlineFonts(), manifest()],
  // The SDK is a linked workspace package of TypeScript sources: let Vite
  // transform it instead of pre-bundling it.
  optimizeDeps: {
    exclude: ['@novyse/app-sdk'],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    cssCodeSplit: false,
    // Everything is inlined: the client mounts one file, no sub-resources.
    assetsInlineLimit: 100_000_000,
    // Excalidraw is a big dependency: the warning is noise here.
    chunkSizeWarningLimit: 8000,
  },
});
