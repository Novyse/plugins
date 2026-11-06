import { useEffect, useState } from 'preact/hooks';

import {
  getAppSDK,
  type InitPayload,
  type StateEvent,
} from '@novyse/app-sdk';

import { messagesFor, normalizeLocale, type Locale } from './i18n';

/** The only STATE mutation of this activity. */
const COUNTER = 'COUNTER';

/** A transient ACTION: it must not be replayed to a late joiner. */
const PING = 'PING';

interface CounterEvent {
  value: number;
}

/**
 * The last counter wins: the log is a sequence of mutations, not a snapshot.
 *
 * A real plugin scans from the end for the event that determines its state
 * (a `LOAD_VIDEO`, a committed shape, a turn), because a trimmed log can start
 * in the middle of a game.
 */
function latestCounter(events: StateEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event.type === COUNTER) {
      return (event.data as CounterEvent).value;
    }
  }

  return 0;
}

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [count, setCount] = useState(0);
  const [pings, setPings] = useState(0);
  const [lastPing, setLastPing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);.
  const [locale, setLocale] = useState<Locale>(() => normalizeLocale(navigator.language));
  const t = messagesFor(locale);

  useEffect(() => {
    let alive = true;

    // The snapshot: a late joiner rebuilds from here and then follows the log.
    sdk
      .init()
      .then((payload) => {
        if (!alive) return;

        setInit(payload);
        setLocale(normalizeLocale(payload.locale));
        setParticipants(payload.participants);
        setCount(latestCounter(payload.state.events));
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });

    const offState = sdk.state.on<CounterEvent>(COUNTER, (event) => {
      setCount(event.data.value);
    });

    const offAction = sdk.action.on((event) => {
      if (event.type !== PING) return;

      setPings((value) => value + 1);
      setLastPing(event.sender);
    });

    const offParticipants = sdk.onParticipants(setParticipants);
    const offEnded = sdk.onEnded((reason) =>
      setError(messagesFor(normalizeLocale(init?.locale)).ended(reason)),
    );

    return () => {
      alive = false;
      offState();
      offAction();
      offParticipants();
      offEnded();
    };
  }, []);

  const readOnly = init?.readOnly ?? false;

  const increment = async () => {
    setError(null);

    try {
      await sdk.state.send(COUNTER, { value: count + 1 });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const ping = async () => {
    setError(null);

    try {
      await sdk.action.send(PING, { at: Date.now() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (error && !init) {
    return (
      <main class="flex h-full items-center justify-center p-6 text-center text-sm text-red-300">
        {error}
      </main>
    );
  }

  return (
    <main class="flex h-full flex-col gap-3 bg-neutral-950 p-4 text-neutral-100">
      <header class="flex items-baseline justify-between gap-2">
        <h1 class="text-base font-semibold">{t.title}</h1>
        <span class="text-xs text-neutral-400">
          v{init?.plugin.version ?? '…'}
        </span>
      </header>

      <p class="text-xs text-neutral-400">
        {t.room(init?.room.chatUUID ?? '…', init?.room.subID ?? 0, init?.self ?? '…')}
      </p>

      <ul class="flex flex-wrap gap-1">
        {participants.map((participant) => (
          <li
            key={participant}
            class="rounded bg-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300"
          >
            {participant}
          </li>
        ))}
      </ul>

      <section class="flex items-center gap-4 rounded-lg bg-neutral-900 p-3">
        <span class="text-3xl font-semibold tabular-nums">{count}</span>

        <button
          type="button"
          class="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          onClick={increment}
          disabled={readOnly}
        >
          {t.increment}
        </button>

        <button
          type="button"
          class="rounded-md bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          onClick={ping}
          disabled={readOnly}
        >
          {t.ping}
        </button>

        <span class="ml-auto text-xs text-neutral-400">
          {t.pings(pings)}
          {lastPing ? ` · ${t.lastFrom(lastPing)}` : ''}
        </span>
      </section>

      <footer class="mt-auto flex items-center justify-between text-[11px] text-neutral-500">
        <span>
          {t.events(init?.state.events.length ?? 0, init?.state.truncated ?? false)}
        </span>
        <span>{readOnly ? t.readOnly : t.live}</span>
      </footer>

      {error ? (
        <p class="rounded bg-red-950 px-2 py-1 text-[11px] text-red-300">{error}</p>
      ) : null}
    </main>
  );
}
