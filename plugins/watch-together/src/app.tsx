import { useEffect, useRef, useState } from 'preact/hooks';

import { getAppSDK, type InitPayload } from '@novyse/app-sdk';

import { EmbedError, type Embed, type EmbedCallbacks } from './embed';
import { messagesFor, normalizeLocale, type Locale, type Messages } from './i18n';
import {
  PLAYBACK,
  PLAYER_INTENT,
  detect,
  latestPlayback,
  playbackFromEvent,
  positionAt,
  type DetectionReason,
  type Playback,
  type PlaybackSnapshot,
  type Source,
} from './state';
import { createTwitch } from './twitch';
import { createYouTube } from './youtube';

/** Every how often the local player is compared with the room, in ms. */
const TICK_MS = 500;

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [clockOffset, setClockOffset] = useState(0);

  const [screen, setScreen] = useState<'input' | 'video'>('input');
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const [ready, setReady] = useState(false);
  const [embedError, setEmbedError] = useState<string | null>(null);

  const [locale, setLocale] = useState<Locale>(() => normalizeLocale(navigator.language));

  const hostRef = useRef<HTMLDivElement>(null);
  const embedRef = useRef<Embed | null>(null);
  const snapshotRef = useRef<PlaybackSnapshot | null>(null);
  const initRef = useRef<InitPayload | null>(null);
  const offsetRef = useRef(0);
  const lastSeqRef = useRef(0);
  const lastSourceRef = useRef<string | null>(null);

  const t = messagesFor(locale);
  const messagesRef = useRef<Messages>(t);

  snapshotRef.current = snapshot;
  initRef.current = init;
  offsetRef.current = clockOffset;
  messagesRef.current = t;

  const serverNow = () => Date.now() + offsetRef.current;
  const readOnly = init?.readOnly ?? false;

  /** Writes a snapshot of the room, if this user may. */
  const publish = async (patch: Partial<Playback>): Promise<boolean> => {
    const payload = initRef.current;
    if (!payload || payload.readOnly) return false;

    const base = snapshotRef.current;
    const source = patch.source ?? base?.source;
    if (!source) return false;

    const next: Playback = {
      source,
      playing: patch.playing ?? base?.playing ?? false,
      position: patch.position ?? positionAt(base, serverNow()),
    };

    setLinkError(null);

    try {
      await sdk.state.send(PLAYBACK, next);
      return true;
    } catch (cause) {
      setLinkError(describe(cause, messagesRef.current));

      return false;
    }
  };

  // Lifecycle: the snapshot, then every change of the room.
  useEffect(() => {
    let alive = true;

    sdk
      .init()
      .then((payload) => {
        if (!alive) return;

        const last = latestPlayback(payload.state.events);

        initRef.current = payload;
        offsetRef.current = payload.serverNow - Date.now();

        lastSeqRef.current = payload.state.seq;
        lastSourceRef.current = last?.source.url ?? null;

        setInit(payload);
        setLocale(normalizeLocale(payload.locale));
        setClockOffset(payload.serverNow - Date.now());
        setSnapshot(last);
        setScreen(last ? 'video' : 'input');
      })
      .catch((cause: unknown) => {
        if (alive) setLinkError(describe(cause, messagesRef.current));
      });

    // The log comes back to the sender too: the sequence number is what makes
    // a duplicate a no-op instead of a double apply.
    const offState = sdk.state.on<Playback>(PLAYBACK, (event) => {
      if (event.seq <= lastSeqRef.current) return;

      const next = playbackFromEvent(event);
      if (!next) return;

      lastSeqRef.current = event.seq;

      const changed = lastSourceRef.current !== next.source.url;
      lastSourceRef.current = next.source.url;

      setSnapshot(next);
      if (changed) setScreen('video');
    });

    // The native player is owned by the app, which is the only side that can
    // see a seek or a pause made with its chrome: it reports the intent as a
    // room action, and the log is written here, where the schema lives.
    const offPlayerIntent = sdk.action.on((event) => {
      if (event.type !== PLAYER_INTENT) return;

      // Only the plugin of the user who touched the player writes the log: the
      // action reaches the whole room, and every copy publishing it would put
      // the same snapshot in the log once per client.
      const self = initRef.current?.self;
      if (!self || event.sender !== self) return;

      const current = snapshotRef.current;
      if (!current || current.source.kind !== 'file') return;

      const data = event.data as { playing?: unknown; position?: unknown } | null;
      const position = Number(data?.position);
      if (!Number.isFinite(position)) return;

      void publish({
        source: current.source,
        playing: Boolean(data?.playing),
        position: Math.max(0, position),
      });
    });

    // The app player was closed from its back button: back to the first screen.
    const offPlayer = sdk.player.onClosed(() => {
      setEmbedError(null);
      setReady(false);
      setScreen('input');
    });

    const offParticipants = sdk.onParticipants(() => {
      // Counted by the room, nothing to do here: the host owns the list.
    });

    const offEnded = sdk.onEnded(() => {
      setLinkError(messagesRef.current.activityClosed);
    });

    return () => {
      alive = false;
      offState();
      offPlayerIntent();
      offPlayer();
      offParticipants();
      offEnded();
    };
  }, []);

  // Mounts the player of the current source, once per source.
  //
  // A YouTube video is an iframe driven by its API. A file is not played here
  // at all: the app owns media_kit, renders it above this sandbox and tells us
  // when its back button is pressed.
  useEffect(() => {
    if (!init || !snapshot || screen !== 'video') return;

    const source = snapshot.source;

    setEmbedError(null);

    if (source.kind === 'file') {
      let disposed = false;

      sdk.player.open(source.url).catch((cause: unknown) => {
        if (!disposed) setEmbedError(describe(cause, messagesRef.current));
      });

      return () => {
        disposed = true;
        void sdk.player.close().catch(() => undefined);
      };
    }

    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let embed: Embed | null = null;

    const callbacks: EmbedCallbacks = {
      onReady: () => {
        if (!disposed) setReady(true);
      },
      onError: (error: EmbedError) => {
        if (!disposed) setEmbedError(describe(error, messagesRef.current));
      },
      onIntent: (playing: boolean, position: number) => {
        if (disposed) return;
        void publish({ source, playing, position });
      },
    };

    const creation =
      source.kind === 'youtube'
        ? createYouTube(host, source, callbacks)
        : createTwitch(
            host,
            source,
            callbacks,
            snapshotRef.current?.playing ?? false,
          );

    creation
      .then((created) => {
        if (disposed) {
          created.destroy();
          return;
        }

        embed = created;
        embedRef.current = created;

        const current = snapshotRef.current;
        created.load(positionAt(current, serverNow()), current?.playing ?? false);
      })
      .catch((cause: unknown) => {
        if (!disposed) setEmbedError(describe(cause, messagesRef.current));
      });

    return () => {
      disposed = true;
      embed?.destroy();

      if (embedRef.current === embed) embedRef.current = null;
    };
  }, [init !== null, screen, snapshot?.source.url]);

  // Reconciliation: play/pause and the position are both applied here, on a
  // number derived from the snapshot, so keeping two players together costs no
  // write at all. `tick` reports a seek made with the player's own controls.
  useEffect(() => {
    if (!snapshot || screen !== 'video') return;

    const timer = window.setInterval(() => {
      const current = snapshotRef.current;
      if (!current) return;

      const expected = positionAt(current, serverNow());

      // A file is played by the app: there is no embed to drive, only a room
      // to follow, and the app reports its own intents back as an action.
      if (current.source.kind === 'file') {
        void sdk.player.sync(current.playing, expected).catch(() => undefined);
        return;
      }

      const embed = embedRef.current;
      if (!embed) return;

      // The jump the user just made is read before the room is applied: `align`
      // seeks the player back to the time of the room, and `tick` compares
      // against the previous sample, so doing this after erased the seek
      // before it could ever be published.
      embed.tick();

      embed.apply(current.playing);
      embed.align(expected);
    }, TICK_MS);

    return () => window.clearInterval(timer);
  }, [screen, snapshot?.source.url]);

  // No chrome over the player: Escape is the shortcut back to the input.
  useEffect(() => {
    if (screen !== 'video') return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      event.preventDefault();
      backToInput();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [screen]);

  const submit = async () => {
    setTouched(true);

    const result = detect(link);

    if (!result.ok) {
      setLinkError(reasonMessage(result.reason, t));
      return;
    }

    const published = await publish({
      source: result.source,
      playing: false,
      position: 0,
    });

    if (!published) return;

    lastSourceRef.current = result.source.url;

    setLink('');
    setLinkError(null);
    setTouched(false);
    setScreen('video');
  };

  const backToInput = () => {
    setEmbedError(null);
    setReady(false);
    setLink('');
    setLinkError(null);
    setTouched(false);
    setScreen('input');
  };

  const detection = detect(link);
  const detected = detection.ok ? detection.source : null;
  const shownError =
    linkError ?? (touched && !detection.ok ? reasonMessage(detection.reason, t) : null);

  if (!snapshot || screen === 'input') {
    return (
      <main class="flex h-full items-center justify-center bg-black px-5 text-neutral-100">
        <div class="w-full max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div class="flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900 py-1.5 pl-4 pr-1.5 focus-within:border-neutral-600">
              <input
                class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-600 disabled:opacity-60"
                placeholder={t.placeholder}
                value={link}
                disabled={readOnly}
                onInput={(event) => {
                  setLink((event.target as HTMLInputElement).value);
                  setLinkError(null);
                  setTouched(false);
                }}
              />

              <button
                type="submit"
                aria-label={t.watch}
                disabled={readOnly}
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-neutral-300 transition hover:bg-neutral-700 disabled:opacity-30"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>

            <p class="mt-3 h-4 text-center text-[11px]">
              {shownError ? (
                <span class="text-red-400">{shownError}</span>
              ) : detected ? (
                <span class="text-neutral-500">
                  {t.detected(platformName(detected, t))}
                </span>
              ) : (
                <span class="text-neutral-600">
                  {readOnly ? t.readOnlyHint : t.hint}
                </span>
              )}
            </p>
          </form>

          {/* The room keeps playing while this client picks another link: the
              way back must not be a reload of the activity. */}
          {snapshot ? (
            <button
              type="button"
              class="mx-auto mt-4 block text-[11px] text-neutral-500 underline-offset-2 transition hover:text-neutral-200 hover:underline"
              onClick={() => {
                setEmbedError(null);
                setLinkError(null);
                setScreen('video');
              }}
            >
              {t.backToVideo}
            </button>
          ) : null}
        </div>
      </main>
    );
  }

  const source = snapshot.source;

  return (
    <main class="relative h-full overflow-hidden bg-black text-neutral-100">
      <div class="relative h-full">
        {source.kind === 'file' ? (
          <div class="grid h-full place-items-center px-6 text-center">
            {embedError ? (
              <div class="max-w-xs">
                <p class="text-[11px] text-red-300">{embedError}</p>
                <p class="mt-1 text-[11px] text-neutral-500">{t.fileNeedsApp}</p>
                <button
                  type="button"
                  class="mt-3 rounded-md bg-neutral-800 px-3 py-1.5 text-[11px] text-neutral-200"
                  onClick={backToInput}
                >
                  {t.chooseAnother}
                </button>
              </div>
            ) : (
              <p class="text-[11px] text-neutral-500">{t.playingInApp}</p>
            )}
          </div>
        ) : (
          <>
            <div
              ref={hostRef}
              class="absolute inset-0 [&>div]:h-full [&>div]:w-full [&_iframe]:h-full [&_iframe]:w-full"
            />

            {embedError ? (
              <div class="absolute inset-0 grid place-items-center bg-black px-5 text-center">
                <p class="text-[11px] text-red-300">{embedError}</p>
              </div>
            ) : !ready ? (
              <div class="pointer-events-none absolute inset-0 grid place-items-center bg-black">
                <p class="text-[11px] text-neutral-500">{t.loading}</p>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* A bar over the video was too much: one translucent button, out of the
          way until the pointer is on it. Escape does the same thing. */}
      <button
        type="button"
        aria-label={t.changeVideo}
        title={t.changeVideoHint}
        class="absolute left-2 top-2 z-10 grid h-7 w-7 place-items-center rounded-full bg-black/50 text-white/60 opacity-50 backdrop-blur-sm transition hover:bg-black/75 hover:text-white hover:opacity-100 focus-visible:opacity-100"
        onClick={backToInput}
      >
        <svg
          viewBox="0 0 24 24"
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 8h10a4 4 0 0 1 0 8H9" />
          <path d="M7 5 4 8l3 3" />
          <path d="M12 13l-3 3 3 3" />
        </svg>
      </button>
    </main>
  );
}

function platformName(source: Source, t: Messages): string {
  switch (source.kind) {
    case 'youtube':
      return t.platformYoutube;
    case 'twitch':
      return source.live ? t.platformTwitchLive : t.platformTwitchVideo;
    case 'file':
      return t.platformFile;
  }
}

function reasonMessage(reason: DetectionReason, t: Messages): string {
  if (reason === 'empty') return t.errorEmpty;
  if (reason === 'insecure') return t.errorInsecure;
  return t.errorInvalid;
}

function describe(cause: unknown, t: Messages): string {
  if (cause instanceof EmbedError) {
    return t.embedError(cause.embedCode, cause.detail);
  }

  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }

  return String(cause);
}
