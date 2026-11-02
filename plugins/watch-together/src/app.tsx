import { useEffect, useRef, useState } from 'preact/hooks';

import { getAppSDK, type InitPayload } from '@novyse/app-sdk';

import {
  PLAYBACK,
  formatTime,
  latestPlayback,
  parseVideoId,
  positionAt,
  type Playback,
  type PlaybackSnapshot,
} from './state';
import { createPlayer, type Player } from './youtube';

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [link, setLink] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [playerReady, setPlayerReady] = useState(false);
  const [playerFailed, setPlayerFailed] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const [seeking, setSeeking] = useState<number | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const loadedVideoRef = useRef<string | null>(null);
  const snapshotRef = useRef<PlaybackSnapshot | null>(null);
  const offsetRef = useRef(0);

  offsetRef.current = clockOffset;
  snapshotRef.current = snapshot;

  const serverNow = () => Date.now() + offsetRef.current;
  const readOnly = init?.readOnly ?? false;
  const position = seeking ?? positionAt(snapshot, now);

  // Lifecycle: the snapshot, then every change of the room.
  useEffect(() => {
    let alive = true;

    sdk
      .init()
      .then((payload) => {
        if (!alive) return;

        setInit(payload);
        setClockOffset(payload.serverNow - Date.now());
        setSnapshot(latestPlayback(payload.state.events));
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    const offState = sdk.state.on<Playback>(PLAYBACK, (event) => {
      const data = event.data;
      if (!data?.videoId) return;

      setSnapshot({
        videoId: data.videoId,
        playing: Boolean(data.playing),
        position: Math.max(0, Number(data.position) || 0),
        updatedAt: event.ts,
      });
    });

    const offParticipants = sdk.onParticipants(() => {
      // Counted by the room, nothing to do here: the host owns the list.
    });

    const offEnded = sdk.onEnded(() => {
      setError('The activity was closed.');
    });

    return () => {
      alive = false;
      offState();
      offParticipants();
      offEnded();
    };
  }, []);

  // The player is created once, in the element that stays mounted.
  useEffect(() => {
    if (!init || !hostRef.current) return;

    let disposed = false;

    createPlayer(hostRef.current, {
      onUnavailable: (code) => {
        setPlayerFailed(true);
        setError(`YouTube refused this video (code ${code}).`);
      },
    })
      .then((player) => {
        if (disposed) {
          player.destroy();
          return;
        }

        playerRef.current = player;
        setPlayerReady(true);
      })
      .catch((cause: unknown) => {
        if (disposed) return;

        setPlayerFailed(true);
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      disposed = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [init !== null]);

  // Reconciliation: every snapshot is applied to the local player.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !snapshot) return;

    if (loadedVideoRef.current !== snapshot.videoId) {
      loadedVideoRef.current = snapshot.videoId;
      player.load(snapshot.videoId, positionAt(snapshot, serverNow()), snapshot.playing);
      return;
    }

    player.apply(snapshot.playing, positionAt(snapshot, serverNow()), snapshot.videoId);
  }, [snapshot, playerReady]);

  // Coarse clock: re-renders the progress bar and nudges a drifting player.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());

      const player = playerRef.current;
      const current = snapshotRef.current;
      if (!player || !current) return;

      if (!current.playing) {
        setAutoplayBlocked(false);
        return;
      }

      const target = positionAt(current, serverNow());

      if (Math.abs(player.position() - target) > 1.5) {
        player.apply(true, target, current.videoId);
      }

      setAutoplayBlocked(!player.playing());
    }, 2000);

    return () => window.clearInterval(timer);
  }, []);

  const publish = async (patch: Partial<Playback>) => {
    if (!init || readOnly) return;

    const base = snapshot;
    const next: Playback = {
      videoId: patch.videoId ?? base?.videoId ?? '',
      playing: patch.playing ?? base?.playing ?? false,
      position: patch.position ?? positionAt(base, serverNow()),
    };

    if (!next.videoId) return;

    setError(null);

    try {
      await sdk.state.send(PLAYBACK, next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const loadVideo = async () => {
    const id = parseVideoId(link);

    if (!id) {
      setError('That is not a YouTube link.');
      return;
    }

    setLink('');
    setEditing(false);
    await publish({ videoId: id, playing: false, position: 0 });
  };

  const toggle = () => {
    void publish({
      playing: !(snapshot?.playing ?? false),
      position: positionAt(snapshot, serverNow()),
    });
  };

  const commitSeek = (seconds: number) => {
    setSeeking(null);
    void publish({ position: seconds });
  };

  const hasVideo = Boolean(snapshot?.videoId);

  return (
    <main class="relative flex h-full flex-col bg-black text-neutral-100">
      {/* The player lives here for the whole life of the tile. */}
      <div ref={hostRef} class="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full" />

      {!hasVideo ? (
        <div class="relative z-10 m-auto w-full max-w-sm rounded-xl bg-neutral-900/90 p-4 shadow-lg backdrop-blur">
          <h1 class="text-base font-semibold">Watch together</h1>
          <p class="mt-1 text-xs text-neutral-400">
            Paste a YouTube link: everyone in the room will watch the same video.
          </p>

          {readOnly ? (
            <p class="mt-3 rounded bg-neutral-800 px-2 py-1.5 text-[11px] text-neutral-400">
              You can watch, but only members who can start activities can pick the video.
            </p>
          ) : (
            <div class="mt-3 flex gap-2">
              <input
                class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1.5 text-sm outline-none focus:border-sky-500"
                placeholder="https://youtu.be/…"
                value={link}
                onInput={(event) => setLink((event.target as HTMLInputElement).value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void loadVideo();
                }}
              />
              <button
                type="button"
                class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white"
                onClick={loadVideo}
              >
                Load
              </button>
            </div>
          )}

          {error ? (
            <p class="mt-2 rounded bg-red-950 px-2 py-1 text-[11px] text-red-300">{error}</p>
          ) : null}
        </div>
      ) : null}

      {hasVideo ? (
        <>
          {/* Thumbnail while the API is still coming up: a black box looks like a bug. */}
          {!playerReady ? (
            <div class="pointer-events-none absolute inset-0">
              <img
                class="h-full w-full object-cover opacity-60"
                src={`https://i.ytimg.com/vi/${snapshot?.videoId}/hqdefault.jpg`}
                alt=""
              />
            </div>
          ) : null}

          {!readOnly && autoplayBlocked ? (
            <button
              type="button"
              class="absolute inset-0 z-10 flex items-center justify-center bg-black/50 text-sm font-medium"
              onClick={toggle}
            >
              Tap to sync playback
            </button>
          ) : null}

          <div class="relative z-20 mt-auto bg-gradient-to-t from-black/90 to-transparent p-2">
            <div class="flex items-center gap-2">
              {!readOnly ? (
                <button
                  type="button"
                  class="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-xs"
                  onClick={toggle}
                  title={snapshot?.playing ? 'Pause' : 'Play'}
                >
                  {snapshot?.playing ? '❙❙' : '▶'}
                </button>
              ) : null}

              <span class="w-10 text-right text-[11px] tabular-nums text-neutral-300">
                {formatTime(position)}
              </span>

              <input
                type="range"
                class="h-1 min-w-0 flex-1 accent-sky-500"
                min={0}
                max={Math.max(1, Math.floor(positionAt(snapshot, serverNow())) + 1)}
                step={1}
                value={Math.floor(position)}
                disabled={readOnly}
                onInput={(event) => setSeeking(Number((event.target as HTMLInputElement).value))}
                onChange={(event) => commitSeek(Number((event.target as HTMLInputElement).value))}
              />

              {!readOnly ? (
                <button
                  type="button"
                  class="rounded bg-white/10 px-2 py-1 text-[11px]"
                  onClick={() => setEditing((value) => !value)}
                  title="Change video"
                >
                  {editing ? 'Close' : 'Link'}
                </button>
              ) : null}
            </div>

            {editing && !readOnly ? (
              <div class="mt-2 flex gap-2">
                <input
                  class="min-w-0 flex-1 rounded-md border border-neutral-700 bg-black/60 px-2 py-1.5 text-xs outline-none focus:border-sky-500"
                  placeholder="Another YouTube link"
                  value={link}
                  onInput={(event) => setLink((event.target as HTMLInputElement).value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void loadVideo();
                  }}
                />
                <button
                  type="button"
                  class="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white"
                  onClick={loadVideo}
                >
                  Load
                </button>
              </div>
            ) : null}

            {error || playerFailed ? (
              <p class="mt-1 truncate text-[11px] text-red-300">
                {error ?? 'The player is not available on this device.'}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </main>
  );
}
