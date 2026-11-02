# Watch Together

Watch a YouTube video together, in sync, from inside a Novyse voice room.

## How the sync works

One `STATE` event type only, `PLAYBACK`, carrying the full intent:

```ts
{ videoId: 'dQw4w9WgXcQ', playing: true, position: 42.5 }
```

`position` is the position at the moment the server stored the event (`ts`).
From there the expected position is `position + (serverNow - ts)`, so a client
that joins late, or one that missed a few seconds of socket, computes the same
frame as everyone else without asking anybody.

- **late joiner**: `init().state.events` → the last `PLAYBACK` wins → the player
  is loaded at the extrapolated position;
- **drift**: every 2 s the local player is compared with the expected position;
  it is seeked only when it is off by more than 1.5 s, so a small buffering
  hiccup does not cause a seek storm;
- **anyone controls**: there is no host client. Anyone with the activities
  permission sends a `PLAYBACK`; the server stamps `seq`, `sender` and `ts` and
  the event comes back to the sender too, which reconciles instead of
  double-applying.

## YouTube specifics

The video is the YouTube iframe, driven through the IFrame Player API. The
plugin never decodes video and never proxies it.

- The document is served from `file://` on native and from an opaque origin on
  the web, so the API may refuse to answer. `createPlayer` then fails (8 s
  timeout or script error) and the tile keeps a thumbnail and a message instead
  of a black rectangle.
- A browser may refuse `playVideo()` without a user gesture: the tile then shows
  **Tap to sync playback**, one tap on each participant and the room is aligned.
- The player needs `frame-src` for `https://www.youtube.com` and
  `https://www.youtube-nocookie.com`, granted by the host CSP. Nothing else
  about the CSP changes.

## Develop

```sh
npm install
npm run dev
```

Two tabs = two participants: load a link in one and it appears in the other.

## Build and publish

```sh
npm run build                                   # dist/index.html + dist/manifest.json
cd ../.. && node scripts/bundle.mjs watch-together --update-registry
git add plugins/watch-together registry.json
git commit -m "watch-together 0.1.0"
git tag watch-together@0.1.0 && git push origin main --tags
```

`bundle.mjs` builds the zip deterministically and writes its `sha256` and
`sizeBytes` into `registry.json`: the digest committed in the registry is the
digest of the asset CI publishes, so the native clients can verify the
download.
