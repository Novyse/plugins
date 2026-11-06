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

## Capabilities and permissions

Both live in `plugin.json` and reach the store through `registry.json`, so the
app can show them before a plugin is installed.

| Field | Values | Meaning |
| :--- | :--- | :--- |
| `capabilities` | `stream`, `fullscreen`, `network` | Host features. `stream` gates `sdk.stream.send` (the app refuses it otherwise); `fullscreen` gates `ui.requestFullscreen`; `network` declares resources loaded from outside the sandbox, whose allowlist is `permissions.frame`. Empty is valid and means none. |
| `permissions.channels` | `state`, `action`, `stream` | The communication channels the plugin writes to. Required: the app refuses a write on a channel that is not listed. |
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
