# Developing Excalidraw

How the board is synced, why the bundle carries its own fonts, and what is still
missing. The README is the store page, keep it user-facing.

## The bundle is one file

`dist/index.html` holds the JavaScript, the CSS and every font: the client
mounts that one document and nothing else, and a plugin may not fetch from an
origin it did not declare. Excalidraw makes that harder than it sounds.

### Fonts

Excalidraw registers its text fonts as `FontFace` objects built at runtime:

```ts
new FontFace(family, `url(${EXCALIDRAW_ASSET_PATH}/fonts/<family>/<subset>.woff2) …`)
```

with `https://esm.sh/@excalidraw/excalidraw/dist/prod/` appended as a fallback,
so a missing file is not a missing font: it is a request to another domain.

`vite.config.ts` emits `virtual:excalidraw-fonts`, every woff2 subset of the
package as a `data:` URL, and `src/assets.ts` wraps `FontFace` and `fetch` to
answer those URLs from the bundle. The wrap drops a font URL it has no bytes for
instead of letting the browser try it: `Xiaolai`, the CJK family, is 13 MB and is
left out (the system font covers those characters). `src/assets.ts` is imported
first in `main.tsx`, because the faces are built while the Excalidraw module is
evaluated.

That is why the important part of the shell is `window.EXCALIDRAW_ASSET_PATH`:
the URLs stay predictable, and `assets.ts` rewrites them all.

### Languages

The package imports its ~60 language files statically, inside one map. The
`novyse-locales` plugin in `vite.config.ts` turns every loader except `en` and
`it` into a rejecting one, which is never called (`langCode` is only one of the
two) and lets Rollup drop the module: 1.7 MB less in the file. The build prints
`locales: kept 2, dropped …`; if it prints the warning instead, the package
changed shape and the bundle carries every language again.

## The protocol

`STATE` is an append-only, server-ordered log replayed in full to a late joiner,
so the log *is* the board. Four event types, each a complete statement:

| Event | Payload | Meaning |
| --- | --- | --- |
| `UPSERT` | `{ elements: ExcalidrawElement[] }` | the elements that changed, added or updated |
| `DELETE` | `{ ids: string[] }` | the elements that are gone |
| `APP_STATE` | `{ viewBackgroundColor?, gridSize? }` | the page: background and grid |

Add and update are one event because Excalidraw versions its elements: two
clients editing the same one are resolved with their own rule, higher `version`
then higher `versionNonce`, so no event has to say which of the two it is.

### Why the diff is not the version

Every local change is found by comparing the scene with the last state the room
was told about (`Board.sigs`), where each element is reduced to a *signature*:
its JSON without `version`, `versionNonce` and `updated`. Comparing versions
instead would republish every element as soon as Excalidraw bumps a nonce on a
programmatic update, and the log would fill with echoes of itself. `Board.sync`
also re-reads the signatures after `updateScene`, because Excalidraw may
normalize an element it is given.

`APP_STATE` is compared field by field against `folder.appState()`, so a redraw
that does not touch the background sends nothing.

### No snapshots

There is no snapshot event, on purpose. `STATE` is append-only and the log *is*
the board: a joiner folds every event it receives at `init()` and that is the
whole history, in the only order the server ever assigned. A snapshot would be a
second, competing history — a client could publish one built from a board it
believed complete and replace the room with it, which is exactly the loss a
monotonic log exists to prevent.

The budget is not a guess: the host refuses a `STATE` write whose `data` is over
16 KiB, counted in UTF-8 bytes, with `E_TOO_LARGE`. `chunkElements` and
`chunkIds` therefore measure the encoded payload and stop at 12 KiB, envelope
included, so a chunk that is measured as fitting can never be refused. An
element that is over the ceiling on its own is left out of the room and the
banner says so, instead of stopping every other change with it.

If the server trimmed the log, `init().state.truncated` says the oldest events
are gone: the board starts from what the log still holds.

### Applying a remote event

`render()` rebuilds the canvas from the folded board plus the elements the local
user is still drawing (they are not in the board yet: dropping them would delete
the line under the mouse). `APP_STATE` is applied on its own, and only the two
shared fields: zoom, scroll, selection and the tool in hand belong to the screen.

## Live strokes

`STREAM` carries JSON packets, treated as disposable:

| Packet | Content | Rate |
| --- | --- | --- |
| `{ k: 's', … }` | a stroke: tool, color, width, opacity, points | ~30 Hz, 64 points per packet |
| `{ k: 'e', id }` | that stroke is over | once |
| `{ k: 'p', x, y }` | cursor position | ~16 Hz, min 3 px of movement |

A preview lives 20 s without news, a cursor 8 s. The end of a stroke also travels
on `ACTION`, which is reliable and not replayed, so the ghost of your own line
disappears at once instead of waiting for the shape to land in `STATE`. Points
are stored in scene coordinates and mapped to the screen with the viewport of
the moment (`(scene + scroll) * zoom`), so a preview stays glued to the canvas
while someone else zooms.

## Develop

```sh
npm install
npm run dev
```

Two tabs are two participants, a third is the late joiner. `?lang=it` switches
the language, `?readonly=1` the passive view. There is no host outside `vite`:
`main.tsx` installs the fake one only when `import.meta.env.DEV`, and the build
drops that branch.

## Build and publish

```sh
npm run build
cd ../..
node scripts/bundle.mjs excalidraw --update-registry
```

`npm run build` writes `dist/index.html` and `dist/manifest.json`. The single
file is ~7 MB because Excalidraw is: the zip is stored without compression, so
that size is what a client downloads once.

## Still open

- **Files**: an image element references a `fileId`, and the bytes are not in
  the element. `onChange` exposes them as `BinaryFiles`; sending them through
  the `STATE` log would mean base64 in a log that gets trimmed, so the right
  place is a separate store. Until then an image stays on the device that added
  it.
- **Text measurement**: a font subset missing from the bundle changes the width
  of text in the CJK family only, and the board falls back to a system font.
