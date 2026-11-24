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
  CLOCK,
  DEFAULT_ALARM,
  DEFAULT_DURATIONS,
  DEFAULT_SNAPSHOT,
  DEFAULT_STOPWATCH,
  DEFAULT_TIMER,
  HOUR,
  MAX_DURATION_MS,
  MINUTE,
  PHASES,
  SECOND,
  TOOLS,
  alarmRemainingAt,
  formatClockTime,
  formatStopwatch,
  formatTime,
  latestClock,
  nextFireAtMs,
  normalizeDurations,
  normalizeSnapshot,
  stopwatchElapsedAt,
  timerRemainingAt,
  type AlarmState,
  type ClockAnchor,
  type ClockSnapshot,
  type Durations,
  type Phase,
  type Tool,
} from './clock';

/** Radius of the progress ring, in the coordinates of its viewBox. */
const RING_RADIUS = 54;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** A local tick: running tools are derived from the server clock, not counted. */
const TICK_MS = 100;

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

function alarmPartsOf(alarm: AlarmState): DurationParts {
  return { hours: alarm.hour, minutes: alarm.minute, seconds: alarm.second };
}

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [anchor, setAnchor] = useState<ClockAnchor | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [locale, setLocale] = useState<Locale>(() => normalizeLocale(navigator.language));
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [readOnly, setReadOnly] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [durations, setDurations] = useState<Durations>(DEFAULT_DURATIONS);
  const [draft, setDraft] = useState<DurationParts>(() => partsOf(DEFAULT_DURATIONS.focus));
  const [alarmDraft, setAlarmDraft] = useState<DurationParts>(() => alarmPartsOf(DEFAULT_ALARM));

  const anchorRef = useRef<ClockAnchor | null>(null);
  /** `serverNow - Date.now()`: the only clock running tools follow. */
  const offsetRef = useRef(0);
  const lastSeqRef = useRef(0);
  const readyRef = useRef(false);
  const queuedRef = useRef<StateEvent[]>([]);
  const readOnlyRef = useRef(false);
  const chimeKeyRef = useRef('');
  const draftRef = useRef(draft);
  const alarmDraftRef = useRef(alarmDraft);
  const durationsRef = useRef(durations);
  const phaseRef = useRef<Phase>('focus');
  const dirtyRef = useRef(false);
  const alarmDirtyRef = useRef(false);
  const commitTimeoutRef = useRef(0);
  const alarmCommitTimeoutRef = useRef(0);

  const t = messagesFor(locale);

  draftRef.current = draft;
  alarmDraftRef.current = alarmDraft;
  durationsRef.current = durations;

  const adopt = useCallback((next: ClockAnchor | null) => {
    anchorRef.current = next;
    setAnchor(next);
  }, []);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  /**
   * Full snapshot to publish: every running tool is re-sampled at `serverNow`
   * so a single event `ts` stays enough to extrapolate them all.
   */
  const snapshotNow = useCallback((): ClockSnapshot => {
    const current = anchorRef.current;
    const base = current ?? { ...DEFAULT_SNAPSHOT, seq: 0, at: serverNow() };
    const nowMs = serverNow();

    return {
      tool: base.tool,
      timer: {
        ...base.timer,
        remainingMs: timerRemainingAt(current, nowMs),
      },
      stopwatch: {
        ...base.stopwatch,
        elapsedMs: stopwatchElapsedAt(current, nowMs),
      },
      alarm: { ...base.alarm },
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
    async (snapshot: ClockSnapshot) => {
      if (readOnlyRef.current) return;

      setError(null);
      adopt({ ...snapshot, seq: lastSeqRef.current, at: serverNow() });

      try {
        const ack = await sdk.state.send(CLOCK, snapshot);

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

    const offState = sdk.state.on(CLOCK, handle);
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
        adopt(latestClock(payload.state.events));

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
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);

    return () => window.clearInterval(tick);
  }, []);

  useEffect(
    () => () => {
      if (commitTimeoutRef.current) window.clearTimeout(commitTimeoutRef.current);
      if (alarmCommitTimeoutRef.current) window.clearTimeout(alarmCommitTimeoutRef.current);
    },
    [],
  );

  const tool = anchor?.tool ?? 'timer';
  const timer = anchor?.timer ?? DEFAULT_TIMER;
  const stopwatch = anchor?.stopwatch ?? DEFAULT_STOPWATCH;
  const alarm = anchor?.alarm ?? DEFAULT_ALARM;
  const phase = timer.phase;
  phaseRef.current = phase;

  const nowMs = now + offsetRef.current;
  const timerRemaining = timerRemainingAt(anchor, nowMs);
  const stopwatchElapsed = stopwatchElapsedAt(anchor, nowMs);
  const alarmRemaining = alarmRemainingAt(alarm, nowMs);
  const locked = readOnly || ended !== null;

  const timerDurationMs = timer.durationMs || durations[phase];
  const timerRatio =
    timerDurationMs > 0 ? Math.max(0, Math.min(1, timerRemaining / timerDurationMs)) : 0;
  const stopwatchRatio = Math.max(0, Math.min(1, (stopwatchElapsed % MINUTE) / MINUTE));
  // Alarm ring fills over the last hour before fire; full when ringing.
  const alarmRatio = alarm.ringing
    ? 1
    : alarmRemaining === null
      ? 0
      : Math.max(0, Math.min(1, 1 - Math.min(HOUR, alarmRemaining) / HOUR));

  const canAdjustTimer = tool === 'timer' && (!timer.running || timerRemaining <= 0);
  const canAdjustAlarm = tool === 'alarm' && !alarm.ringing && alarm.fireAtMs === null;

  // A paused timer shows the time it has left, not the length it started
  // from: editing here edits the remaining time, and play resumes from it.
  const editableTimerMs =
    anchor && !timer.running && timerRemaining > 0 ? timerRemaining : timerDurationMs;

  useEffect(() => {
    if (dirtyRef.current || tool !== 'timer') return;

    setDraft(partsOf(editableTimerMs));
  }, [editableTimerMs, phase, tool]);

  useEffect(() => {
    if (alarmDirtyRef.current || tool !== 'alarm') return;

    setAlarmDraft(alarmPartsOf(alarm));
  }, [alarm.hour, alarm.minute, alarm.second, tool, alarm]);

  const chimeFor = useCallback((key: string) => {
    if (chimeKeyRef.current === key) return;

    chimeKeyRef.current = key;
    playChime();
  }, []);

  // Timer end chime.
  useEffect(() => {
    if (!timer.running || !anchor) return;

    const key = `timer:${anchor.seq}:${timer.phase}:${anchor.at}`;
    const left = timerRemainingAt(anchor, Date.now() + offsetRef.current);

    if (left <= 0) {
      chimeFor(key);
      return;
    }

    const timeout = window.setTimeout(() => chimeFor(key), left + 40);
    return () => window.clearTimeout(timeout);
  }, [anchor, timer.running, timer.phase, chimeFor]);

  useEffect(() => {
    if (!timer.running || timerRemaining > 0 || !anchor) return;

    chimeFor(`timer:${anchor.seq}:${timer.phase}:${anchor.at}`);
  }, [anchor, timer.running, timer.phase, timerRemaining, chimeFor]);

  // Alarm fire: chime and mark ringing so the whole room sees it.
  useEffect(() => {
    if (!anchor || alarm.fireAtMs === null || alarm.ringing) return;

    const key = `alarm:${alarm.fireAtMs}`;
    const left = alarm.fireAtMs - (Date.now() + offsetRef.current);

    const fire = () => {
      chimeFor(key);
      if (readOnlyRef.current) return;

      const snapshot = snapshotNow();
      if (snapshot.alarm.ringing || snapshot.alarm.fireAtMs === null) return;

      void publish({
        ...snapshot,
        alarm: { ...snapshot.alarm, ringing: true },
      });
    };

    if (left <= 0) {
      fire();
      return;
    }

    const timeout = window.setTimeout(fire, left + 40);
    return () => window.clearTimeout(timeout);
  }, [anchor, alarm.fireAtMs, alarm.ringing, chimeFor, publish, snapshotNow]);

  // Keep chiming while the alarm is ringing.
  useEffect(() => {
    if (!alarm.ringing) return;

    playChime();
    const interval = window.setInterval(() => playChime(), 2_500);
    return () => window.clearInterval(interval);
  }, [alarm.ringing]);

  const saveDurations = (next: Durations) => {
    durationsRef.current = next;
    setDurations(next);
    void sdk.storage.set('durations', next).catch(() => {});
  };

  const commitTimerDuration = (parts: DurationParts) => {
    const next = durationOf(parts);
    const nextDurations = { ...durationsRef.current, [phaseRef.current]: next };
    const snapshot = snapshotNow();

    saveDurations(nextDurations);
    void publish({
      ...snapshot,
      tool: 'timer',
      timer: {
        phase: phaseRef.current,
        durationMs: next,
        remainingMs: next,
        running: false,
      },
    });
  };

  const updateTimerDraft = (next: DurationParts) => {
    if (locked) return;

    draftRef.current = next;
    setDraft(next);
    dirtyRef.current = true;

    if (commitTimeoutRef.current) window.clearTimeout(commitTimeoutRef.current);
    commitTimeoutRef.current = window.setTimeout(() => {
      commitTimeoutRef.current = 0;
      if (!dirtyRef.current) return;

      dirtyRef.current = false;
      commitTimerDuration(next);
    }, COMMIT_MS);
  };

  const flushTimerDraftLocal = (): number | null => {
    if (!dirtyRef.current) return null;

    if (commitTimeoutRef.current) {
      window.clearTimeout(commitTimeoutRef.current);
      commitTimeoutRef.current = 0;
    }

    dirtyRef.current = false;

    const next = durationOf(draftRef.current);
    saveDurations({ ...durationsRef.current, [phaseRef.current]: next });

    return next;
  };

  const setTimerPart = (key: keyof DurationParts, raw: number) => {
    const max = key === 'hours' ? 99 : 59;
    const value = Number.isFinite(raw) ? Math.min(max, Math.max(0, Math.round(raw))) : 0;
    const next = { ...draftRef.current, [key]: value };

    if (next.hours === 0 && next.minutes === 0 && next.seconds === 0) next.seconds = 1;

    updateTimerDraft(next);
  };

  const stepTimerPart = (key: keyof DurationParts, direction: 1 | -1) => {
    if (locked) return;

    const current = draftRef.current;
    const total = current.hours * 3600 + current.minutes * 60 + current.seconds;
    const delta = key === 'hours' ? 3600 : key === 'minutes' ? 60 : 1;
    const nextTotal = Math.min(
      MAX_DURATION_MS / SECOND,
      Math.max(1, total + direction * delta),
    );

    updateTimerDraft(partsOf(nextTotal * SECOND));
  };

  const commitAlarmDraft = (parts: DurationParts) => {
    const snapshot = snapshotNow();

    void publish({
      ...snapshot,
      tool: 'alarm',
      alarm: {
        hour: parts.hours,
        minute: parts.minutes,
        second: parts.seconds,
        fireAtMs: null,
        ringing: false,
      },
    });
  };

  const updateAlarmDraft = (next: DurationParts) => {
    if (locked || !canAdjustAlarm) return;

    alarmDraftRef.current = next;
    setAlarmDraft(next);
    alarmDirtyRef.current = true;

    if (alarmCommitTimeoutRef.current) window.clearTimeout(alarmCommitTimeoutRef.current);
    alarmCommitTimeoutRef.current = window.setTimeout(() => {
      alarmCommitTimeoutRef.current = 0;
      if (!alarmDirtyRef.current) return;

      alarmDirtyRef.current = false;
      commitAlarmDraft(next);
    }, COMMIT_MS);
  };

  const flushAlarmDraftLocal = (): DurationParts => {
    if (alarmDirtyRef.current) {
      if (alarmCommitTimeoutRef.current) {
        window.clearTimeout(alarmCommitTimeoutRef.current);
        alarmCommitTimeoutRef.current = 0;
      }
      alarmDirtyRef.current = false;
    }

    return alarmDraftRef.current;
  };

  const setAlarmPart = (key: keyof DurationParts, raw: number) => {
    const max = key === 'hours' ? 23 : 59;
    const value = Number.isFinite(raw) ? Math.min(max, Math.max(0, Math.round(raw))) : 0;

    updateAlarmDraft({ ...alarmDraftRef.current, [key]: value });
  };

  const stepAlarmPart = (key: keyof DurationParts, direction: 1 | -1) => {
    if (locked || !canAdjustAlarm) return;

    const current = alarmDraftRef.current;
    const max = key === 'hours' ? 23 : 59;
    const value = (current[key] + direction + (max + 1)) % (max + 1);

    updateAlarmDraft({ ...current, [key]: value });
  };

  const selectTool = (next: Tool) => {
    const snapshot = snapshotNow();
    if (snapshot.tool === next) return;

    primeAudio();
    flushTimerDraftLocal();
    flushAlarmDraftLocal();
    dirtyRef.current = false;
    alarmDirtyRef.current = false;

    void publish({ ...snapshot, tool: next });
  };

  const selectPhase = (next: Phase) => {
    const snapshot = snapshotNow();
    if (snapshot.timer.phase === next) return;

    primeAudio();
    flushTimerDraftLocal();

    const duration = durationsRef.current[next];
    dirtyRef.current = false;
    setDraft(partsOf(duration));
    void publish({
      ...snapshot,
      tool: 'timer',
      timer: {
        phase: next,
        durationMs: duration,
        remainingMs: duration,
        running: false,
      },
    });
  };

  const toggleTimer = () => {
    primeAudio();

    const pending = flushTimerDraftLocal();
    const snapshot = snapshotNow();
    const { timer: current } = snapshot;

    if (current.running && current.remainingMs > 0) {
      void publish({
        ...snapshot,
        tool: 'timer',
        timer: { ...current, running: false },
      });
      return;
    }

    const duration = pending ?? current.durationMs;
    const remainingMs =
      pending !== null
        ? duration
        : current.remainingMs > 0
          ? current.remainingMs
          : duration;

    void publish({
      ...snapshot,
      tool: 'timer',
      timer: {
        phase: current.phase,
        durationMs: duration,
        remainingMs,
        running: true,
      },
    });
  };

  const resetTimer = () => {
    primeAudio();

    const pending = flushTimerDraftLocal();
    const snapshot = snapshotNow();
    const duration = pending ?? snapshot.timer.durationMs;

    setDraft(partsOf(duration));
    void publish({
      ...snapshot,
      tool: 'timer',
      timer: {
        ...snapshot.timer,
        durationMs: duration,
        remainingMs: duration,
        running: false,
      },
    });
  };

  const toggleStopwatch = () => {
    primeAudio();
    const snapshot = snapshotNow();

    void publish({
      ...snapshot,
      tool: 'stopwatch',
      stopwatch: {
        elapsedMs: snapshot.stopwatch.elapsedMs,
        running: !snapshot.stopwatch.running,
      },
    });
  };

  const resetStopwatch = () => {
    primeAudio();
    const snapshot = snapshotNow();

    void publish({
      ...snapshot,
      tool: 'stopwatch',
      stopwatch: { ...DEFAULT_STOPWATCH },
    });
  };

  const armAlarm = () => {
    primeAudio();
    const parts = flushAlarmDraftLocal();
    const snapshot = snapshotNow();
    const localNow = Date.now();
    const fireAtMs = nextFireAtMs(parts.hours, parts.minutes, parts.seconds, localNow);

    void publish({
      ...snapshot,
      tool: 'alarm',
      alarm: {
        hour: parts.hours,
        minute: parts.minutes,
        second: parts.seconds,
        fireAtMs,
        ringing: false,
      },
    });
  };

  const disarmAlarm = () => {
    primeAudio();
    const parts = flushAlarmDraftLocal();
    const snapshot = snapshotNow();

    void publish({
      ...snapshot,
      tool: 'alarm',
      alarm: {
        hour: parts.hours,
        minute: parts.minutes,
        second: parts.seconds,
        fireAtMs: null,
        ringing: false,
      },
    });
  };

  const dismissAlarm = () => {
    primeAudio();
    const snapshot = snapshotNow();

    void publish({
      ...snapshot,
      tool: 'alarm',
      alarm: {
        ...snapshot.alarm,
        fireAtMs: null,
        ringing: false,
      },
    });
  };

  const toolLabel = (value: Tool) =>
    value === 'timer' ? t.toolTimer : value === 'stopwatch' ? t.toolStopwatch : t.toolAlarm;

  const phaseLabel = (value: Phase) =>
    value === 'focus' ? t.phaseFocus : t.phaseShort;

  const timerStatus =
    timerRemaining <= 0 ? t.done : timer.running ? t.running : t.paused;
  const stopwatchStatus = stopwatch.running ? t.running : t.paused;
  const alarmStatus = alarm.ringing
    ? t.ringing
    : alarm.fireAtMs !== null
      ? t.armed
      : t.idle;

  const timerStartLabel =
    timer.running && timerRemaining > 0
      ? t.pause
      : timerRemaining <= 0
        ? t.restart
        : t.start;

  const stopwatchStartLabel = stopwatch.running ? t.pause : t.start;

  const dialRatio =
    tool === 'timer' ? timerRatio : tool === 'stopwatch' ? stopwatchRatio : alarmRatio;

  if (!init) {
    return (
      <main class="clock clock--dark">
        <p class="clock__loading">{error ? `${t.error}: ${error}` : t.loading}</p>
      </main>
    );
  }

  return (
    <main
      class={`clock clock--${theme}`}
      data-tool={tool}
      data-phase={phase}
      data-editing={canAdjustTimer || canAdjustAlarm ? 'true' : 'false'}
      data-ringing={alarm.ringing ? 'true' : 'false'}
      onPointerDown={() => primeAudio()}
    >
      <header class="clock__header">
        <div class="clock__heading">
          <h1 class="clock__title">{t.title}</h1>
          <p class="clock__subtitle">{t.tagline}</p>
        </div>
      </header>

      <div class="clock__tools" role="tablist" aria-label={t.title}>
        {TOOLS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={item === tool}
            class={`tool ${item === tool ? 'tool--active' : ''}`}
            onClick={() => selectTool(item)}
            disabled={locked}
          >
            {toolLabel(item)}
          </button>
        ))}
      </div>

      {tool === 'timer' ? (
        <div class="clock__phases" role="tablist" aria-label={t.toolTimer}>
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
              {phaseLabel(item)}
            </button>
          ))}
        </div>
      ) : null}

      <div class="clock__dial">
        <svg class="dial" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="dial__track" cx="60" cy="60" r={RING_RADIUS} />
          <circle
            class="dial__value"
            cx="60"
            cy="60"
            r={RING_RADIUS}
            transform="rotate(-90 60 60)"
            strokeDasharray={RING_LENGTH}
            strokeDashoffset={RING_LENGTH * (1 - dialRatio)}
          />
        </svg>

        <div class="dial__center">
          {tool === 'timer' && canAdjustTimer ? (
            <div class="dial__editor" aria-label={t.duration}>
              <TimeColumn
                value={draft.hours}
                unit={t.hours}
                label={t.hoursLong}
                increase={t.increase(t.hoursLong)}
                decrease={t.decrease(t.hoursLong)}
                disabled={locked}
                onChange={(value) => setTimerPart('hours', value)}
                onStep={(direction) => stepTimerPart('hours', direction)}
              />
              <span class="dial__colon">:</span>
              <TimeColumn
                value={draft.minutes}
                unit={t.minutes}
                label={t.minutesLong}
                increase={t.increase(t.minutesLong)}
                decrease={t.decrease(t.minutesLong)}
                disabled={locked}
                onChange={(value) => setTimerPart('minutes', value)}
                onStep={(direction) => stepTimerPart('minutes', direction)}
              />
              <span class="dial__colon">:</span>
              <TimeColumn
                value={draft.seconds}
                unit={t.seconds}
                label={t.secondsLong}
                increase={t.increase(t.secondsLong)}
                decrease={t.decrease(t.secondsLong)}
                disabled={locked}
                onChange={(value) => setTimerPart('seconds', value)}
                onStep={(direction) => stepTimerPart('seconds', direction)}
              />
            </div>
          ) : null}

          {tool === 'timer' && !canAdjustTimer ? (
            <span class="dial__time">{formatTime(timerRemaining)}</span>
          ) : null}

          {tool === 'stopwatch' ? (
            <span class="dial__time dial__time--stopwatch">
              {formatStopwatch(stopwatchElapsed)}
            </span>
          ) : null}

          {tool === 'alarm' && canAdjustAlarm ? (
            <div class="dial__editor" aria-label={t.alarmTime}>
              <TimeColumn
                value={alarmDraft.hours}
                unit={t.hours}
                label={t.hoursLong}
                increase={t.increase(t.hoursLong)}
                decrease={t.decrease(t.hoursLong)}
                disabled={locked}
                onChange={(value) => setAlarmPart('hours', value)}
                onStep={(direction) => stepAlarmPart('hours', direction)}
              />
              <span class="dial__colon">:</span>
              <TimeColumn
                value={alarmDraft.minutes}
                unit={t.minutes}
                label={t.minutesLong}
                increase={t.increase(t.minutesLong)}
                decrease={t.decrease(t.minutesLong)}
                disabled={locked}
                onChange={(value) => setAlarmPart('minutes', value)}
                onStep={(direction) => stepAlarmPart('minutes', direction)}
              />
              <span class="dial__colon">:</span>
              <TimeColumn
                value={alarmDraft.seconds}
                unit={t.seconds}
                label={t.secondsLong}
                increase={t.increase(t.secondsLong)}
                decrease={t.decrease(t.secondsLong)}
                disabled={locked}
                onChange={(value) => setAlarmPart('seconds', value)}
                onStep={(direction) => stepAlarmPart('seconds', direction)}
              />
            </div>
          ) : null}

          {tool === 'alarm' && !canAdjustAlarm ? (
            <span class="dial__time">
              {alarm.ringing
                ? formatClockTime(Date.now())
                : formatTime(alarmRemaining ?? 0)}
            </span>
          ) : null}

          <span class="dial__state">
            {tool === 'timer'
              ? timerStatus
              : tool === 'stopwatch'
                ? stopwatchStatus
                : alarmStatus}
          </span>

          {tool === 'alarm' && alarm.fireAtMs !== null && !alarm.ringing ? (
            <span class="dial__hint">{t.ringsAt(formatClockTime(alarm.fireAtMs))}</span>
          ) : null}
        </div>
      </div>

      <div class="clock__controls">
        {tool === 'timer' ? (
          <>
            <button
              type="button"
              class="button button--primary"
              onClick={toggleTimer}
              disabled={locked}
            >
              {timerStartLabel}
            </button>
            <button type="button" class="button" onClick={resetTimer} disabled={locked}>
              {t.reset}
            </button>
          </>
        ) : null}

        {tool === 'stopwatch' ? (
          <>
            <button
              type="button"
              class="button button--primary"
              onClick={toggleStopwatch}
              disabled={locked}
            >
              {stopwatchStartLabel}
            </button>
            <button type="button" class="button" onClick={resetStopwatch} disabled={locked}>
              {t.reset}
            </button>
          </>
        ) : null}

        {tool === 'alarm' ? (
          alarm.ringing ? (
            <button
              type="button"
              class="button button--primary"
              onClick={dismissAlarm}
              disabled={locked}
            >
              {t.dismiss}
            </button>
          ) : alarm.fireAtMs !== null ? (
            <button
              type="button"
              class="button button--primary"
              onClick={disarmAlarm}
              disabled={locked}
            >
              {t.disarm}
            </button>
          ) : (
            <button
              type="button"
              class="button button--primary"
              onClick={armAlarm}
              disabled={locked}
            >
              {t.arm}
            </button>
          )
        ) : null}
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
