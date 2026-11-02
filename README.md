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
    plugin.json               source metadata (id, version, capabilities)
    src/                      sources (React/Preact/TS/...)
    dist/                     built bundle: index.html, manifest.json, icon.png
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

## Publishing a plugin

1. Build the plugin so that `plugins/<slug>/dist/index.html` is a single self-contained
   document (all CSS and JS inlined, no relative assets).
2. Set the same `version` in `plugins/<slug>/plugin.json` and in `registry.json`, together
   with `sha256` and `sizeBytes` of the bundle.
3. Commit `src/`, `dist/`, `plugin.json` and `registry.json`.
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
```

## License

GNU General Public License v3.0, see [LICENSE](LICENSE).
