import FONTS from 'virtual:excalidraw-fonts';

/**
 * The fonts of the board, served from the bundle.
 *
 * Excalidraw registers its text fonts as `FontFace` objects built from absolute
 * URLs: `<EXCALIDRAW_ASSET_PATH>/fonts/<family>/<subset>.woff2`, plus an
 * `esm.sh` fallback for the asset path that does not answer. Neither URL can
 * work in a plugin bundle, which is one file mounted in a sandbox, and the
 * fallback would be an external request. So the bytes travel in the bundle and
 * these two hooks answer for them:
 *
 * - `FontFace`, which is how a subset is registered and loaded;
 * - `fetch`, which the SVG export uses to embed the glyphs of the text.
 *
 * Any font URL without bytes here (the CJK family, left out for its size) is
 * dropped from the source instead of being attempted, because a request to a
 * domain the plugin never declared is exactly what must not happen.
 */

const MARKER = '/fonts/';
/** A valid `FontFace` source, and the closest thing to "the system font". */
const FALLBACK_SOURCE = 'local("sans-serif")';

/**
 * A base URL that always parses.
 */
const ASSET_BASE = 'https://plugin.novyse.invalid/';

// Excalidraw reads this before it builds any font URL. One value covers the
// served build and the in-memory one; the hooks below answer the requests.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = ASSET_BASE;

const ASSETS: Record<string, string> = FONTS;

/** The inlined bytes of a font URL, or `null` when it is not ours. */
function inlined(url: string): string | null {
  let pathname: string;

  try {
    pathname = new URL(url, ASSET_BASE).pathname;
  } catch {
    return null;
  }

  const marker = pathname.indexOf(MARKER);

  if (marker < 0) return null;

  return ASSETS[pathname.slice(marker + MARKER.length)] ?? null;
}

const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)(?:\s*format\(\s*([^)]*?)\s*\))?/g;

/**
 * Rewrites `url(…)` entries to the data URLs of the bundle.
 *
 * A source that is not a list of URLs (`local(...)`, a `data:` URL, an
 * ArrayBuffer) is returned untouched.
 */
function rewriteSource(source: string): string {
  const sources: string[] = [];
  let found = false;

  for (const match of source.matchAll(URL_PATTERN)) {
    found = true;

    const data = inlined(match[2]);
    if (!data) continue;

    sources.push(`url("${data}")${match[3] ? ` format(${match[3]})` : ' format("woff2")'}`);
  }

  if (!found) return source;
  if (sources.length === 0) return FALLBACK_SOURCE;

  return sources.join(', ');
}

function decode(dataUrl: string): ArrayBuffer {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return buffer;
}

/**
 * Installs the two hooks. Call it before importing anything that touches a
 * font, which is why `main.tsx` imports this module first.
 */
export function installOfflineAssets(): void {
  if (!('FontFace' in window)) return;

  const NativeFontFace = window.FontFace;

  window.FontFace = new Proxy(NativeFontFace, {
    construct(target, args: unknown[]) {
      const [family, source, descriptors] = args as [
        string,
        string | BufferSource,
        FontFaceDescriptors?,
      ];

      const rewritten = typeof source === 'string' ? rewriteSource(source) : source;

      return Reflect.construct(target, [family, rewritten, descriptors]);
    },
  }) as unknown as typeof FontFace;

  const nativeFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const data = inlined(url);

    if (!data) return nativeFetch(input, init);

    return Promise.resolve(
      new Response(decode(data), {
        status: 200,
        headers: { 'Content-Type': 'font/woff2' },
      }),
    );
  };
}

installOfflineAssets();
