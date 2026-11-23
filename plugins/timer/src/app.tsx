import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import {
  getAppSDK,
  type InitPayload,
  type StateEvent,
  type ThemeMode,
} from '@novyse/app-sdk';

import { messagesFor, normalizeLocale, type Locale } from './i18n';
import { playChime, unlockAudio } from './sound';
import {
  DEFAULT_DURATIONS,
  MAX_DURATION_MS,
  PHASES,
  SECOND,
  TIMER,
  formatTime,
  latestTimer,
  normalizeDurations,
  normalizeSnapshot,
  remainingAt,
  type Durations,
  type Phase,
  type TimerAnchor,
  type TimerSnapshot,
} from './timer';

/** Radius of the progress ring, in the coordinates of its viewBox. */
const RING_RADIUS = 54;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A local tick: the countdown is derived from the server clock, not counted. */
const TICK_MS = 250;

/** The picker publishes 250 ms after the last change, never on every digit. */
const COMMIT_MS = 250;

interface DurationParts {
  hours: number;
  minutes: number;
  seconds: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function partsOf(ms: number): DurationParts {
  const total = Math.max(0, Math.round(ms / SECOND));

  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

function durationOf(parts: DurationParts): number {
  const total = parts.hours * 3600 + parts.minutes * 60 + parts.seconds;

  return Math.min(MAX_DURATION_MS, Math.max(SECOND, total * SECOND));
}

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [anchor, setAnchor] = useState<TimerAnchor | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [locale, setLocale] = useState<Locale>(() => normalizeLocale(navigator.language));
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [readOnly, setReadOnly] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [durations, setDurations] = useState<Durations>(DEFAULT_DURATIONS);
  const [draft, setDraft] = useState<DurationParts>(() => partsOf(DEFAULT_DURATIONS.focus));

  const anchorRef = useRef<TimerAnchor | null>(null);
  /** `serverNow - Date.now()`: the only clock the countdown follows. */
  const offsetRef = useRef(0);
  const lastSeqRef = useRef(0);
  const readyRef = useRef(false);
  const queuedRef = useRef<StateEvent[]>([]);
  const readOnlyRef = useRef(false);
  const chimeKeyRef = useRef('');
  const draftRef = useRef(draft);
  const durationsRef = useRef(durations);
  const phaseRef = useRef<Phase>('focus');
  const dirtyRef = useRef(false);
  const commitTimerRef = useRef(0);

  const t = messagesFor(locale);

  draftRef.current = draft;
  durationsRef.current = durations;

  const adopt = useCallback((next: TimerAnchor | null) => {
    anchorRef.current = next;
    setAnchor(next);
  }, []);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  /** The snapshot to publish for the next mutation, as of right now. */
  const snapshotNow = useCallback((): TimerSnapshot => {
    const current = anchorRef.current;
    const phase = current?.phase ?? 'focus';
    const fallback = durationsRef.current[phase];
    const durationMs = current?.durationMs ?? fallback;

    return {
      phase,
      durationMs,
      remainingMs: current ? remainingAt(current, serverNow()) : fallback,
      running: current?.running ?? false,
    };
  }, [serverNow]);

  const handle = useCallback(
    (event: StateEvent) => {
      if (!readyRef.current) {
        queuedRef.current.push(event);
        return;
      }

      if (event.seq <= lastSeqRef.current) return;

      const snapshot = normalizeSnapshot(event.data);
      if (!snapshot) return;

      lastSeqRef.current = event.seq;
      adopt({ ...snapshot, seq: event.seq, at: event.ts });
    },
    [adopt],
  );

  /**
   * Publishes a snapshot and adopts it locally.
   *
   * The server echo carries the authoritative `seq` and `ts`; the optimistic
   * copy only makes the button respond in the same frame. Applying the echo
   * again is a no-op: same `seq`, same snapshot.
   */
  const publish = useCallback(
    async (snapshot: TimerSnapshot) => {
      if (readOnlyRef.current) return;

      setError(null);
      adopt({ ...snapshot, seq: lastSeqRef.current, at: serverNow() });

      try {
        const ack = await sdk.state.send(TIMER, snapshot);

        if (ack.seq > lastSeqRef.current) {
          lastSeqRef.current = ack.seq;
          adopt({ ...snapshot, seq: ack.seq, at: ack.ts });
        }
      } catch (cause) {
        setError(describe(cause));
      }
    },
    [adopt, serverNow, sdk],
  );

  const primeAudio = useCallback(() => {
    void unlockAudio();
  }, []);

  useEffect(() => {
    let alive = true;

    const offState = sdk.state.on(TIMER, handle);
    const offEnded = sdk.onEnded((reason) => setEnded(reason));
    const offTheme =
      sdk.onTheme?.((next) => setTheme(next.theme === 'light' ? 'light' : 'dark')) ?? (() => {});

    void sdk.storage
      .get<Durations>('durations')
      .then((saved) => {
        if (!alive) return;

        setDurations(normalizeDurations(saved));
      })
      .catch(() => {});

    sdk
      .init()
      .then((payload) => {
        if (!alive) return;

        offsetRef.current = payload.serverNow - Date.now();
        lastSeqRef.current = payload.state.seq;
        readOnlyRef.current = payload.readOnly;

        setInit(payload);
        setLocale(normalizeLocale(payload.locale));
        setTheme(payload.theme === 'light' ? 'light' : 'dark');
        setReadOnly(payload.readOnly);
        setNow(Date.now());
        adopt(latestTimer(payload.state.events));

        readyRef.current = true;

        const queued = queuedRef.current;
        queuedRef.current = [];
        for (const event of queued) handle(event);
      })
      .catch((cause: unknown) => {
        if (alive) setError(describe(cause));
      });

    return () => {
      alive = false;
      offState();
      offEnded();
      offTheme();
    };
  }, [adopt, handle, sdk]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(
    () => () => {
      if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    },
    [],
  );

  const phase = anchor?.phase ?? 'focus';
  phaseRef.current = phase;

  const durationMs = anchor?.durationMs ?? durations[phase];
  const remaining = anchor ? remainingAt(anchor, now + offsetRef.current) : durationMs;
  const ratio = durationMs > 0 ? Math.max(0, Math.min(1, remaining / durationMs)) : 0;
  const locked = readOnly || ended !== null;
  const canAdjust = !anchor?.running || remaining <= 0;

  // A paused timer shows the time it has left, not the length it started
  // from: editing here edits the remaining time, and play resumes from it. A
  // phase that has not run yet (`remaining == durationMs`), or one that is
  // over, keeps showing the full duration.
  const editableMs =
    anchor && !anchor.running && remaining > 0 ? remaining : durationMs;

  // Follow the room, unless the user is in the middle of a change that has
  // not been committed yet.
  useEffect(() => {
    if (dirtyRef.current) return;

    setDraft(partsOf(editableMs));
  }, [editableMs, phase]);

  const chimeFor = useCallback((key: string) => {
    if (chimeKeyRef.current === key) return;

    chimeKeyRef.current = key;
    playChime();
  }, []);

  // A timeout at the exact end, so the bell is not tied to the 250 ms tick.
  useEffect(() => {
    if (!anchor?.running) return;

    const key = `${anchor.seq}:${anchor.phase}:${anchor.at}`;
    const left = remainingAt(anchor, Date.now() + offsetRef.current);

    if (left <= 0) {
      chimeFor(key);
      return;
    }

    const timeout = window.setTimeout(() => chimeFor(key), left + 40);
    return () => window.clearTimeout(timeout);
  }, [anchor, chimeFor]);

  // Fallback for a throttled background timer, and for a late joiner that
  // mounts on an activity whose countdown is already at zero.
  useEffect(() => {
    if (!anchor?.running || remaining > 0) return;

    chimeFor(`${anchor.seq}:${anchor.phase}:${anchor.at}`);
  }, [anchor, remaining, chimeFor]);

  const saveDurations = (next: Durations) => {
    durationsRef.current = next;
    setDurations(next);
    void sdk.storage.set('durations', next).catch(() => {});
  };

  const commitDuration = (parts: DurationParts) => {
    const next = durationOf(parts);
    const nextDurations = { ...durationsRef.current, [phaseRef.current]: next };

    saveDurations(nextDurations);
    void publish({
      phase: phaseRef.current,
      durationMs: next,
      remainingMs: next,
      running: false,
    });
  };

  const updateDraft = (next: DurationParts) => {
    if (locked) return;

    draftRef.current = next;
    setDraft(next);
    dirtyRef.current = true;

    if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = window.setTimeout(() => {
      commitTimerRef.current = 0;
      if (!dirtyRef.current) return;

      dirtyRef.current = false;
      commitDuration(next);
    }, COMMIT_MS);
  };

  /** Saves a pending edit locally, without publishing it. */
  const flushDraftLocal = (): number | null => {
    if (!dirtyRef.current) return null;

    if (commitTimerRef.current) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = 0;
    }

    dirtyRef.current = false;

    const next = durationOf(draftRef.current);
    saveDurations({ ...durationsRef.current, [phaseRef.current]: next });

    return next;
  };

  const setPart = (key: keyof DurationParts, raw: number) => {
    const max = key === 'hours' ? 99 : 59;
    const value = Number.isFinite(raw) ? Math.min(max, Math.max(0, Math.round(raw))) : 0;
    const next = { ...draftRef.current, [key]: value };

    if (next.hours === 0 && next.minutes === 0 && next.seconds === 0) next.seconds = 1;

    updateDraft(next);
  };

  const stepPart = (key: keyof DurationParts, direction: 1 | -1) => {
    if (locked) return;

    const current = draftRef.current;
    const total = current.hours * 3600 + current.minutes * 60 + current.seconds;
    const delta = key === 'hours' ? 3600 : key === 'minutes' ? 60 : 1;
    const nextTotal = Math.min(
      MAX_DURATION_MS / SECOND,
      Math.max(1, total + direction * delta),
    );

    updateDraft(partsOf(nextTotal * SECOND));
  };

  const toggle = () => {
    primeAudio();

    const pending = flushDraftLocal();
    const snapshot = snapshotNow();

    if (snapshot.running && snapshot.remainingMs > 0) {
      void publish({ ...snapshot, running: false });
      return;
    }

    const duration = pending ?? snapshot.durationMs;
    const remainingMs =
      pending !== null
        ? duration
        : snapshot.remainingMs > 0
          ? snapshot.remainingMs
          : duration;

    void publish({
      phase: snapshot.phase,
      durationMs: duration,
      remainingMs,
      running: true,
    });
  };

  const reset = () => {
    primeAudio();

    const pending = flushDraftLocal();
    const snapshot = snapshotNow();
    const duration = pending ?? snapshot.durationMs;

    setDraft(partsOf(duration));
    void publish({
      ...snapshot,
      durationMs: duration,
      remainingMs: duration,
      running: false,
    });
  };

  const selectPhase = (next: Phase) => {
    const snapshot = snapshotNow();
    if (snapshot.phase === next) return;

    primeAudio();
    flushDraftLocal();

    const duration = durationsRef.current[next];
    dirtyRef.current = false;
    setDraft(partsOf(duration));
    void publish({
      phase: next,
      durationMs: duration,
      remainingMs: duration,
      running: false,
    });
  };

  const labelOf = (value: Phase) =>
    value === 'focus' ? t.phaseFocus : t.phaseShort;

  const status = remaining <= 0 ? t.done : anchor?.running ? t.running : t.paused;
  const startLabel =
    anchor?.running && remaining > 0 ? t.pause : remaining <= 0 ? t.restart : t.start;

  if (!init) {
    return (
      <main class="timer timer--dark">
        <p class="timer__loading">{error ? `${t.error}: ${error}` : t.loading}</p>
      </main>
    );
  }

  return (
    <main
      class={`timer timer--${theme}`}
      data-phase={phase}
      data-editing={canAdjust ? 'true' : 'false'}
      onPointerDown={() => primeAudio()}
    >
      <header class="timer__header">
        <div class="timer__heading">
          <h1 class="timer__title">{t.title}</h1>
          <p class="timer__subtitle">{t.tagline}</p>
        </div>

      </header>

      <div class="timer__phases" role="tablist" aria-label={t.title}>
        {PHASES.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={item === phase}
            class={`phase ${item === phase ? 'phase--active' : ''}`}
            onClick={() => selectPhase(item)}
            disabled={locked}
          >
            {labelOf(item)}
          </button>
        ))}
      </div>

      <div class="timer__dial">
        <svg class="dial" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="dial__track" cx="60" cy="60" r={RING_RADIUS} />
          <circle
            class="dial__value"
            cx="60"
            cy="60"
            r={RING_RADIUS}
            transform="rotate(-90 60 60)"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - ratio)}
          />
        </svg>

        <div class="dial__center">
          {canAdjust ? (
            <div class="dial__editor" aria-label={t.duration}>
              <TimeColumn
                value={draft.hours}
                unit={t.hours}
                label={t.hoursLong}
                increase={t.increase(t.hoursLong)}
                decrease={t.decrease(t.hoursLong)}
                disabled={locked}
                onChange={(value) => setPart('hours', value)}
                onStep={(direction) => stepPart('hours', direction)}
              />

              <span class="dial__colon">:</span>

              <TimeColumn
                value={draft.minutes}
                unit={t.minutes}
                label={t.minutesLong}
                increase={t.increase(t.minutesLong)}
                decrease={t.decrease(t.minutesLong)}
                disabled={locked}
                onChange={(value) => setPart('minutes', value)}
                onStep={(direction) => stepPart('minutes', direction)}
              />

              <span class="dial__colon">:</span>

              <TimeColumn
                value={draft.seconds}
                unit={t.seconds}
                label={t.secondsLong}
                increase={t.increase(t.secondsLong)}
                decrease={t.decrease(t.secondsLong)}
                disabled={locked}
                onChange={(value) => setPart('seconds', value)}
                onStep={(direction) => stepPart('seconds', direction)}
              />
            </div>
          ) : (
            <span class="dial__time">{formatTime(remaining)}</span>
          )}

          <span class="dial__state">{status}</span>
        </div>
      </div>

      <div class="timer__controls">
        <button
          type="button"
          class="button button--primary"
          onClick={toggle}
          disabled={locked}
        >
          {startLabel}
        </button>

        <button type="button" class="button" onClick={reset} disabled={locked}>
          {t.reset}
        </button>
      </div>

      {readOnly ? <p class="banner">{t.readOnly}</p> : null}
      {ended ? <p class="banner">{t.ended(ended)}</p> : null}
      {error ? (
        <p class="banner banner--error" role="alert">
          {t.error}: {error}
        </p>
      ) : null}
    </main>
  );
}

interface TimeColumnProps {
  value: number;
  unit: string;
  label: string;
  increase: string;
  decrease: string;
  disabled: boolean;
  onChange: (value: number) => void;
  onStep: (direction: 1 | -1) => void;
}

/**
 * One digit column of the central picker: arrows above and below, a number
 * that can also be typed. Every change goes straight to the room (debounced
 * in the parent), there is no Apply button.
 */
function TimeColumn(props: TimeColumnProps) {
  const [text, setText] = useState(() => pad2(props.value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setText(pad2(props.value));
  }, [props.value]);

  return (
    <div class="time-col">
      <button
        type="button"
        class="time-col__arrow"
        onClick={() => props.onStep(1)}
        disabled={props.disabled}
        aria-label={props.increase}
        title={props.increase}
      >
        <ChevronUp />
      </button>

      <input
        class="time-col__value"
        type="text"
        inputMode="numeric"
        value={text}
        disabled={props.disabled}
        aria-label={props.label}
        onFocus={(event) => {
          focusedRef.current = true;
          event.currentTarget.select();
        }}
        onBlur={() => {
          focusedRef.current = false;
          setText(pad2(props.value));
        }}
        onInput={(event) => {
          const digits = event.currentTarget.value.replace(/\D/g, '').slice(0, 2);
          setText(digits);
          props.onChange(digits === '' ? 0 : Number(digits));
        }}
      />

      <button
        type="button"
        class="time-col__arrow"
        onClick={() => props.onStep(-1)}
        disabled={props.disabled}
        aria-label={props.decrease}
        title={props.decrease}
      >
        <ChevronDown />
      </button>

      <span class="time-col__unit">{props.unit}</span>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }

  return String(cause);
}

function ChevronUp() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="m6 15 6-6 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="m6 9 6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
