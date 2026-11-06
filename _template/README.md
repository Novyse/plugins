# Activity template

A working starting point for a Novyse activity: Preact, TypeScript, Vite, and a
single self-contained `dist/index.html` as the only artifact.

## Start a plugin from it

```sh
cp -r _template plugins/my-activity
cd plugins/my-activity
```

Then rename the plugin in three places, they must agree, or the release fails:

1. `plugin.json` → `id` (the slug, `[a-z0-9-]`), `name`, `version`;
2. `/src/main.tsx` → the `installDevHost({ slug })` call (development only);
3. the folder name `plugins/my-activity`.

## Work on it

```sh
npm install
npm run dev
```

`npm run dev` serves the plugin standalone: `src/main.tsx` installs the fake
host of `@novyse/app-sdk/dev` when `import.meta.env.DEV` is true, so the SDK is
there even though the app is not. Open the URL in **two tabs** to see two
participants: the counter increments across tabs through `STATE`, the ping goes
through `ACTION`, and a tab opened later rebuilds from the merged event log,
that is the late joiner path, exercised without a backend.

## Build

```sh
npm run build
```

Two files land in `dist/`:

- `index.html`, with the CSS and the JavaScript inlined (no relative assets, no
  external requests);
- `manifest.json`, generated from `plugin.json` by the `novyse-manifest` plugin
  in `vite.config.ts`.

`dist/` is committed for a real plugin (the web client fetches `dist/index.html`
from the raw URL at the release tag), this template ignores it.

## Publish

From the repository root:

1. add the entry to `registry.json` with `sha256` and `sizeBytes` of the zip;
2. commit `plugins/<slug>/src`, `dist/`, `plugin.json` and `registry.json`;
3. push the tag `<slug>@<version>`, CI validates, zips `dist/` and releases.

## Translation

`src/i18n.ts` holds two tables, English and Italian, and `init().locale` says
which one to use: the host sends its language as a BCP-47 tag (`it-IT`), the
helper matches the base and falls back to English. The manifest lists the same
languages (`locales`), and `npm run dev?lang=it` switches without touching the
system.

Add a language by adding it to `plugin.json`, to `LOCALES` and to the tables.

## What the app shows of a plugin

The store card uses `store/banner.png` (1600×600) and the logo `store/icon.png`
(512×512); the info button opens a page that renders the README of the release
next to the registry metadata (version, author, permissions, size, languages).
Screenshots are simply images in this README, stacked, with absolute URLs.

Because the README is the page, replace it with a user-facing text before
publishing: name, one sentence, a screenshot, how to use it. The internals
belong in a separate `DEVELOPING.md`, like `plugins/watch-together`.

## The contract, in short

| What | Where | Replayed to a late joiner |
| :--- | :--- | :--- |
| Shared state (video position, committed shapes, turn) | `state.send` | **yes** |
| One-off feedback (sound, animation, toast) | `action.send` | no |
| High frequency (ticks, cursors, live strokes) | `stream.send` | no |

`init()` is the snapshot: `state.events` is the log, oldest first, with
`truncated: true` when the oldest events may have been trimmed. Rebuild by
scanning from the end for the event that determines your state, then follow the
new events.

`readOnly` is true for a participant without the activities permission: render
the same view, disable the mutations, and expect `E_FORBIDDEN` if you try
anyway. The server enforces it, not the plugin.
