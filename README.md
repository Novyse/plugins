# Novyse Plugins

Official plugin registry and sandboxed HTML5 activity bundles for Novyse voice rooms.
Static, self-contained builds distributed via GitHub Releases.

## What this repository is

- `registry.json` is the **only source of truth** for the plugin library. The API gateway
  reads it from `raw.githubusercontent.com` and never calls the GitHub API.
- `plugins/<slug>/dist/` is **committed**. The web client fetches
  `dist/index.html` from the raw URL at the release tag, so an uncommitted build would
  not be servable. Native clients download the zip attached to the release.
- The zip is never committed: it is built by CI from the committed `dist/` and attached
  to the GitHub Release.

## Layout

```
registry.json                 index of the library
schema/
  registry.schema.json        shape of registry.json
  manifest.schema.json        shape of dist/manifest.json
scripts/
  validate-registry.mjs       dependency-free validator, run by CI
packages/
  app-sdk/                    @novyse/app-sdk: SDK types + the development host
_template/
  Preact + Vite + Tailwind scaffold, copy it to plugins/<slug> to start
plugins/
  <slug>/
    plugin.json               source metadata (id, version, locales, capabilities, permissions)
    src/                      sources (React/Preact/TS/...)
    dist/                     built bundle: index.html, manifest.json
    store/                    store art: icon.png, banner.png, screenshots
.github/workflows/
  validate.yml                checks on every push and pull request
  release.yml                 publishes the bundle when a tag is pushed
```

## Start a plugin

`_template` is a working plugin: Preact, TypeScript, Vite, Tailwind, and a
single-file build.

```sh
cp -r _template plugins/my-activity
cd plugins/my-activity && npm install && npm run dev
```

`npm run dev` serves it standalone with the fake host of
`@novyse/app-sdk/dev`: open it in two tabs and you have two participants, the
`STATE` log, the `ACTION` channel and a late joiner, without the app. See
[`_template/README.md`](_template/README.md).

## Localization

A plugin is translated in the bundle, not on the server: the app sends its
language and the plugin picks the table.

1. list the languages in `plugin.json`, `en` is mandatory and is the fallback:

   ```json
   "locales": ["en", "it"]
   ```

2. the host passes the language in `init()`:

   ```ts
   const init = await sdk.init(); // init.locale: "it-IT"
   ```

   It is a BCP-47 tag, never a language the manifest does not declare. Match on
   the base language (`it-IT` → `it`) and fall back to `en` for anything else;
   `src/i18n.ts` in the template and in `watch-together` does exactly that and
   can be copied.

3. `npm run dev` accepts `?lang=it` on the URL, so the other language can be
   checked without changing the system locale.

The first frame is rendered before `init()` answers: start from
`navigator.language` (or English) and switch when `init` resolves. Text that
does not change with the language (names of the platforms, for example) still
belongs in the table.

## Colors and theming

A plugin can be colored in two standard ways. **`themeColors` is the default**:
the app sends the palette it is drawing with, so the tile follows the theme
mode, the selected palette and the surface treatment (AMOLED included). The
**theme type** is for a plugin that wants to keep its own palette and only know
whether the app is light or dark.

### The default: `themeColors`

`init().themeColors` is a positional array computed by the client from its
`ColorScheme`. The SDK writes it to CSS custom properties:

| # | Name | CSS variable | Used for |
| :-- | :--- | :--- | :--- |
| 0 | `background` | `--nv-background` | page background |
| 1 | `surface` | `--nv-surface` | cards, panels, bars |
| 2 | `surfaceHover` | `--nv-surface-hover` | hover of a surface |
| 3 | `field` | `--nv-field` | inputs, code areas |
| 4 | `line` | `--nv-line` | borders and dividers |
| 5 | `outline` | `--nv-outline` | tracks, stronger outlines |
| 6 | `text` | `--nv-text` | primary text |
| 7 | `muted` | `--nv-muted` | secondary text and icons |
| 8 | `primary` | `--nv-primary` | the call to action |
| 9 | `onPrimary` | `--nv-on-primary` | text on `primary` |
| 10 | `primarySoft` | `--nv-primary-soft` | tinted primary (16% alpha) |
| 11 | `danger` | `--nv-danger` | errors, destructive actions |
| 12 | `success` | `--nv-success` | success and "go" states |
| 13 | `warning` | `--nv-warning` | warnings |
| 14 | `info` | `--nv-info` | neutral information |

The corner radius of the app travels with the palette but is not a color, so it
is not part of the array: `init().themeRadii` carries `sm`, `md` and `lg` in CSS
pixels, and `watchTheme` writes them to `--nv-radius-sm`, `--nv-radius-md` and
`--nv-radius-lg`.

Use the token the app uses for the same kind of widget, or the tile looks
bolted on next to the rest of the interface:

| Token | Value | Use it for |
| :-- | :-- | :-- |
| `--nv-radius-sm` | 8 px | chips, tabs, small inner rows |
| `--nv-radius-md` | 16 px | buttons, inputs, icon buttons, the toolbar of the activity |
| `--nv-radius-lg` | 24 px | cards, panels, sheets, dialogs |

```css
.panel {
  border-radius: var(--nv-radius-lg, 24px);
}

.button {
  border-radius: var(--nv-radius-md, 16px);
}
```

A circle or a pill stays hardcoded: the host cannot describe it with one number.

Call the helper once in `main.tsx`, before rendering:

```ts
import { getAppSDK, watchTheme } from '@novyse/app-sdk';

watchTheme(getAppSDK());
```

and keep the plugin's own palette as the fallback of every token, so the first
frame is painted before `init()` answers:

```css
.panel {
  background: var(--nv-surface, #0a182f);
  color: var(--nv-text, #eaf2ff);
  border: 1px solid var(--nv-line, #1c2a40);
}
```

`watchTheme` also subscribes to `sdk.onTheme`: when the user changes the theme,
the palette or the surface treatment, the app pushes a new array and the CSS
updates live, without reloading the activity. Pass a listener to redraw
something that CSS cannot express (a canvas).

On Novyse the array is always present. In development the dev host sends
`DEFAULT_THEME_COLORS` for the active mode, so `npm run dev` works without the
app; `?theme=light` switches the sample palette and
`?colors=%23f5f9ff,%23f1f6ff,...` overrides individual slots. The helper is also
safe on an app older than the plugin: without `themeColors` it falls back to the
stock palette of `init().theme`.

### The theme type

A plugin that defines both palettes by itself reads only `init().theme`:

```ts
import { getAppSDK, watchThemeMode } from '@novyse/app-sdk';

watchThemeMode(getAppSDK());
```

```css
:root {
  --bg: #071427;
  --text: #eaf2ff;
}

[data-novyse-theme="light"] {
  --bg: #f5f9ff;
  --text: #0e1826;
}
```

`watchThemeMode` sets `data-novyse-theme` and `color-scheme` on the document and
follows the changes live. `sdk.onTheme` is there if something else needs the
new mode.

Do not mix the two strategies: either define both palettes from `theme`, or use
`themeColors` and let the app choose. A theme palette can still be the fallback
of `var(--nv-…, fallback)`; the host value wins when it is present, which is
always the case inside Novyse. Components with a theme of their own (the
Excalidraw canvas, for example) take the theme type and use `themeColors` for
the chrome around them.

## The chrome of an activity

An activity is a 16:9 surface: the host draws no rail beside it. Closing,
pinning, fullscreen and the context menu are buttons of the plugin, over the
tile, and they call the host through the SDK.

```ts
import { getAppSDK, mountActivityControls, watchTheme } from '@novyse/app-sdk';

const sdk = getAppSDK();
watchTheme(sdk);
mountActivityControls(sdk); // once, in main.tsx
```

`mountActivityControls` draws a small bar in the top-right corner with the same
four buttons for every plugin (close, pin, fullscreen, more), coloured with the
`--nv-*` tokens and rounded with `--nv-radius-md`. It reads `init().controls`
(`{ pinned, fullscreen, closable }`), follows `ui.onControls` live so the pin
button flips when the room pins the tile, and translates the labels with the
language of `init().locale`.

Leave it room: keep the heading of the plugin clear of the top-right corner
(`padding-right: clamp(96px, 34vw, 140px)` on the header is what the timer and
the wheel do), and do not draw those four buttons yourself: a plugin with its
own close button is a plugin that drifts from the app.

The same calls are there for a plugin that wants different buttons:

| Call | What the host does |
| :-- | :-- |
| `ui.close()` | stops the activity in the room |
| `ui.pin()` / `ui.unpin()` | pins the tile over the grid, releases it |
| `ui.requestFullscreen()` / `ui.exitFullscreen()` | fullscreen needs the `fullscreen` capability |
| `ui.openMenu(anchor)` | opens the tile context menu under `{ x, y, width, height }`, in CSS pixels of the sandbox |

## Capabilities and permissions

Both live in `plugin.json` and reach the store through `registry.json`, so the
app can show them before a plugin is installed.

| Field | Values | Meaning |
| :--- | :--- | :--- |
| `capabilities` | `stream`, `fullscreen`, `network` | Host features. `stream` gates `sdk.stream.send` (the app refuses it otherwise); `fullscreen` gates `ui.requestFullscreen`; `network` declares resources loaded from outside the sandbox, whose allowlist is `permissions.frame`. Empty is valid and means none. |
| `permissions.channels` | `state`, `action`, `stream`, `file` | The communication channels the plugin writes to. Required: the app refuses a write on a channel that is not listed. |
| `permissions.frame` | `https://host`, `https://*.host`, with an optional port | Origins the plugin loads into an iframe. No path, no query, https only; at most 8. |

```json
{
  "capabilities": ["network"],
  "permissions": {
    "channels": ["state"],
    "frame": ["https://www.youtube.com"]
  }
}
```

## Big files go on `file`, never on `state`

A `STATE` event is 16 KiB: anything bigger, a photo, a recording, a document,
would mean hundreds of chunked events kept in the log of the room until it is
trimmed. Declare the `file` channel instead and let the bytes travel outside
the log, straight to S3:

1. `sdk.file.upload(name, mimeType, size)` reserves the file on the quota of
   the user uploading and returns a direct S3 `uploadURL` (presigned PUT, 24 h).
2. the plugin `PUT`s the bytes there itself, with `Content-Type: <mimeType>`;
   nothing crosses the app or Redis, so the log stays small;
3. `sdk.file.confirm(fileUUID)` makes the file downloadable — the server
   verifies the object exists before confirming;
4. the plugin publishes a `STATE` event carrying only the reference
   (`{ fileUUID, … }`), which is all a late joiner needs;
5. whoever needs the bytes calls `sdk.file.download(fileUUID)` and `GET`s the
   presigned URL (1 h). Any participant of the chat can download; only the
   uploader can confirm, and only a writer can upload or remove.

Files are temporary and quota-checked: up to 50 MiB each, charged to the
storage of the uploader (507 when full, 413 when over the cap), and deleted
with the activity, stop the activity and the rows, the S3 objects and the
Redis pointers go away. `sdk.file.remove(fileUUID)` deletes one early.
Excalidraw is the reference: its images travel exactly this way (`FILE_REF`
events over `STATE`).

Keep the lists honest: `scripts/validate-registry.mjs` checks that they are
well formed and that `registry.json` mirrors them, but only the code review can
see whether a plugin writes on a channel it did not declare.

## Assets inside the single file

A dependency that loads something at runtime — fonts, workers, language files —
cannot do it from a plugin bundle: `dist/index.html` is fetched as one file and
mounted in a sandbox, so a relative URL has nothing to resolve against and an
absolute one is a request the plugin never declared. Freeze them in at build
time: `assetsInlineLimit` covers images and CSS, and anything the dependency
fetches itself needs the bytes in the bundle plus a small shim that answers its
loader. [`plugins/excalidraw`](plugins/excalidraw/DEVELOPING.md) does exactly
that for the font subsets of Excalidraw, and drops the ones it does not ship
instead of letting the library fall back to a CDN.

Either way, check the result before publishing:

```sh
grep -o 'https://[a-z0-9.-]*' plugins/<slug>/dist/index.html | sort -u
```

should list only namespaces, documentation links and origins that are never
opened at runtime. Watch the size too: the file is committed, zipped without
compression and downloaded on every install, so a few megabytes is the ceiling.

## Store assets

| File | Size | Used as |
| :--- | :--- | :--- |
| `store/icon.png` | 512×512 PNG, transparent background | the logo: 44 px in the store card, 64 px on the plugin page. |
| `store/banner.png` | 1600×600 PNG | the banner of the card and of the plugin page. |
| screenshots | 1920×1080 PNG | inside `README.md`, stacked, rendered by the plugin page. |

`store/` is committed and never zipped: `bundle.mjs` copies `icon` and `banner`
into `registry.json` only when the files exist, so a plugin without art still
builds and the store falls back to a gradient and to the initial of the name.
Keep them out of `dist/`: the build empties that directory.

The card overlays the logo at the bottom-left and the name plus a two-line
preview of the description at the bottom, so keep that band of the banner free
of detail. The app crops with `BoxFit.cover`: the centre of the image is always
visible, the extremes are not.

Screenshots are not a separate field. Put them in the README, one below the
other, as absolute URLs, the plugin page renders the README of the release and
would resolve a relative path against nothing:

```md
![Shared player](./store/screen-1.png)
```

becomes

```md
![Shared player](https://raw.githubusercontent.com/Novyse/plugins/main/plugins/<slug>/store/screen-1.png)
```

Pinning the tag instead of `main` is fine and reproducible; a screenshot rarely
changes between releases, so `main` keeps the README free of per-release edits.

## The plugin page

The store lists the library as cards; the info button of a card opens the page
of that plugin, which renders the README of the release and, next to it, the
metadata from the registry: version, author, size, minimum app version,
languages, capabilities and permissions. Screenshots and any other content are
therefore the README's own, with no field to keep in sync.

The README **is** that page, so write it for the person in the store:

1. the name of the plugin as the title, then one sentence on what it does;
2. a screenshot right after it, as an absolute URL (see above);
3. how to use it: what can be opened or pasted, what is shared between the
   participants, and the limits in a line;
4. nothing about the internals: no event schema, no build commands, no API
   notes.

The technical notes stay next to the sources instead, in a `DEVELOPING.md`:
see [`plugins/watch-together/DEVELOPING.md`](plugins/watch-together/DEVELOPING.md)
for an example.

## Publishing a plugin

1. Build the plugin so that `plugins/<slug>/dist/index.html` is a single self-contained
   document (all CSS and JS inlined, no relative assets).
2. Run the bundler, which zips `dist/` deterministically and writes `sha256`,
   `sizeBytes`, `tag` and the paths into `registry.json`:

   ```sh
   node scripts/bundle.mjs watch-together --update-registry
   ```

   The zip is store-only with fixed timestamps, so the digest is reproducible: the value
   committed on `main` is the digest of the asset CI publishes, and the native clients
   verify the download against it.
3. Commit `src/`, `dist/`, `plugin.json`, `registry.json` and the tag of the release.
4. Push the tag `<slug>@<version>`:

   ```sh
   git tag watch-together@1.2.0
   git push origin main --tags
   ```

5. CI validates the registry, checks that the tag matches `plugin.json`, zips `dist/` into
   `<slug>-bundle.zip` and creates the release.
6. The API gateway picks the new `registry.json` within 30 seconds; the client downloads
   the new version on its next launch.

Tags are immutable, a version is never reused, and an already published bundle never
changes. A rollback is a new patch version pointing at the previous build.

## Local checks

```sh
node scripts/validate-registry.mjs
node scripts/bundle.mjs <slug> --check-registry
```

## License

GNU General Public License v3.0, see [LICENSE](LICENSE).
