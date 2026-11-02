# Activity template

A working starting point for a Novyse activity: Preact, TypeScript, Vite, and a
single self-contained `dist/index.html` as the only artifact.

## Start a plugin from it

```sh
cp -r _template plugins/my-activity
cd plugins/my-activity
```

Then rename the plugin in three places — they must agree, or the release fails:

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
through `ACTION`, and a tab opened later rebuilds from the merged event log —
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
from the raw URL at the release tag) — this template ignores it.

## Publish

From the repository root:

1. add the entry to `registry.json` with `sha256` and `sizeBytes` of the zip;
2. commit `plugins/<slug>/src`, `dist/`, `plugin.json` and `registry.json`;
3. push the tag `<slug>@<version>` — CI validates, zips `dist/` and releases.

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
