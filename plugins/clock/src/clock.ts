import type { StateEvent } from '@novyse/app-sdk';

/**
 * The only STATE mutation of the activity: a complete clock snapshot.
 *
 * Clock is the room activity; inside it live three tools (timer, stopwatch,
 * alarm). One event type carrying the full intent makes the log trivially
 * replayable: the last `CLOCK` wins for a late joiner, and a client that
 * missed a few seconds recomputes each running tool from `ts` and the
 * server clock.
 */
export const CLOCK = 'CLOCK';

export type Tool = 'timer' | 'stopwatch' | 'alarm';

export const TOOLS: readonly Tool[] = ['timer', 'stopwatch', 'alarm'];

export type Phase = 'focus' | 'short';

export const PHASES: readonly Phase[] = ['focus', 'short'];

/** Length of each timer mode, in milliseconds, as saved on this device. */
export interface Durations {
  focus: number;
  short: number;
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** 99:59:59, the ceiling of the inline duration editor and stopwatch. */
export const MAX_DURATION_MS = 99 * HOUR + 59 * MINUTE + 59 * SECOND;

export const MIN_DURATION_MS = SECOND;

export const DEFAULT_DURATIONS: Durations = {
  focus: 25 * MINUTE,
  short: 5 * MINUTE,
};

/** Countdown tool: focus or short break. */
export interface TimerState {
  phase: Phase;
  /** Length of the mode this snapshot belongs to. */
  durationMs: number;
  /** Time left at the event `ts`; while running, subtract elapsed time from it. */
  remainingMs: number;
  running: boolean;
}

/** Count-up tool. */
export interface StopwatchState {
  /** Elapsed time at the event `ts`; while running, add elapsed time to it. */
  elapsedMs: number;
  running: boolean;
}

/**
 * Alarm tool: an absolute fire time shared by the room.
 *
 * `hour` / `minute` / `second` keep the picker in sync; `fireAtMs` is the
 * authority for when every client rings.
 */
export interface AlarmState {
  hour: number;
  minute: number;
  second: number;
  /** Absolute server time of the next ring, or `null` when disarmed. */
  fireAtMs: number | null;
  ringing: boolean;
}

export interface ClockSnapshot {
  tool: Tool;
  timer: TimerState;
  stopwatch: StopwatchState;
  alarm: AlarmState;
}

export interface ClockAnchor extends ClockSnapshot {
  seq: number;
  /** Server time of the event, used to extrapolate running tools. */
  at: number;
}

export const DEFAULT_TIMER: TimerState = {
  phase: 'focus',
  durationMs: DEFAULT_DURATIONS.focus,
  remainingMs: DEFAULT_DURATIONS.focus,
  running: false,
};

export const DEFAULT_STOPWATCH: StopwatchState = {
  elapsedMs: 0,
  running: false,
};

export const DEFAULT_ALARM: AlarmState = {
  hour: 9,
  minute: 0,
  second: 0,
  fireAtMs: null,
  ringing: false,
};

export const DEFAULT_SNAPSHOT: ClockSnapshot = {
  tool: 'timer',
  timer: DEFAULT_TIMER,
  stopwatch: DEFAULT_STOPWATCH,
  alarm: DEFAULT_ALARM,
};

export function isTool(value: unknown): value is Tool {
  return value === 'timer' || value === 'stopwatch' || value === 'alarm';
}

export function isPhase(value: unknown): value is Phase {
  return value === 'focus' || value === 'short';
}

function clampDuration(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;

  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(value)));
}

function clampElapsed(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;

  return Math.min(MAX_DURATION_MS, Math.round(value));
}

function clampUnit(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.min(max, Math.max(0, Math.round(value)));
}

/** Durations read from local storage, with every field clamped. */
export function normalizeDurations(raw: unknown): Durations {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  return {
    focus: clampDuration(Number(data.focus), DEFAULT_DURATIONS.focus),
    short: clampDuration(Number(data.short), DEFAULT_DURATIONS.short),
  };
}

function normalizeTimer(raw: unknown, fallbackPhase: Phase = 'focus'): TimerState {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const phase = isPhase(data.phase) ? data.phase : fallbackPhase;
  const durationMs = clampDuration(Number(data.durationMs), DEFAULT_DURATIONS[phase]);
  const remaining = Number(data.remainingMs);
  const remainingMs = Number.isFinite(remaining)
    ? Math.min(durationMs, Math.max(0, Math.round(remaining)))
    : durationMs;

  return {
    phase,
    durationMs,
    remainingMs,
    running: data.running === true,
  };
}

function normalizeStopwatch(raw: unknown): StopwatchState {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  return {
    elapsedMs: clampElapsed(Number(data.elapsedMs)),
    running: data.running === true,
  };
}

function normalizeAlarm(raw: unknown): AlarmState {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const fireRaw = data.fireAtMs;
  const fireAtMs =
    fireRaw === null || fireRaw === undefined
      ? null
      : Number.isFinite(Number(fireRaw))
        ? Math.round(Number(fireRaw))
        : null;

  return {
    hour: clampUnit(Number(data.hour), 23),
    minute: clampUnit(Number(data.minute), 59),
    second: clampUnit(Number(data.second), 59),
    fireAtMs,
    ringing: data.ringing === true,
  };
}

/**
 * Everything coming from the wire is validated. Legacy timer-only payloads
 * (no `tool` field) are lifted into the full clock snapshot.
 */
export function normalizeSnapshot(raw: unknown): ClockSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;

  const data = raw as Record<string, unknown>;

  // Legacy: a bare timer snapshot from before the multi-tool clock.
  if (!('tool' in data) && isPhase(data.phase)) {
    return {
      tool: 'timer',
      timer: normalizeTimer(data),
      stopwatch: { ...DEFAULT_STOPWATCH },
      alarm: { ...DEFAULT_ALARM },
    };
  }

  if (!isTool(data.tool)) return null;

  return {
    tool: data.tool,
    timer: normalizeTimer(data.timer, DEFAULT_TIMER.phase),
    stopwatch: normalizeStopwatch(data.stopwatch),
    alarm: normalizeAlarm(data.alarm),
  };
}

/** The last snapshot in the log, `null` when no clock was ever published. */
export function latestClock(events: StateEvent[]): ClockAnchor | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== CLOCK) continue;

    const snapshot = normalizeSnapshot(event.data);
    if (snapshot) return { ...snapshot, seq: event.seq, at: event.ts };
  }

  return null;
}

/**
 * Time left on the timer right now.
 *
 * A paused timer keeps its stored remaining time; a running one subtracts the
 * server time elapsed since the event. The server clock is the authority, so
 * a client whose own clock is skewed still lands on the same second.
 */
export function timerRemainingAt(anchor: ClockAnchor | null, serverNow: number): number {
  const timer = anchor?.timer ?? DEFAULT_TIMER;
  if (!anchor || !timer.running) return timer.remainingMs;

  return Math.max(0, timer.remainingMs - Math.max(0, serverNow - anchor.at));
}

/** Elapsed time on the stopwatch right now. */
export function stopwatchElapsedAt(anchor: ClockAnchor | null, serverNow: number): number {
  const stopwatch = anchor?.stopwatch ?? DEFAULT_STOPWATCH;
  if (!anchor || !stopwatch.running) return stopwatch.elapsedMs;

  return Math.min(
    MAX_DURATION_MS,
    stopwatch.elapsedMs + Math.max(0, serverNow - anchor.at),
  );
}

/** Milliseconds until the alarm fires; `null` when disarmed. */
export function alarmRemainingAt(alarm: AlarmState, serverNow: number): number | null {
  if (alarm.fireAtMs === null) return null;

  return Math.max(0, alarm.fireAtMs - serverNow);
}

/**
 * Next absolute time for the given local wall clock, at least a beat in the
 * future so arming "now" still schedules a real ring.
 */
export function nextFireAtMs(
  hour: number,
  minute: number,
  second: number,
  localNowMs: number,
): number {
  const local = new Date(localNowMs);
  const candidate = new Date(localNowMs);
  candidate.setHours(hour, minute, second, 0);

  if (candidate.getTime() <= local.getTime() + 500) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate.getTime();
}

/** `MM:SS`, or `H:MM:SS` once past an hour. Countdown uses ceil. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** Stopwatch display with a tenth of a second. */
export function formatStopwatch(ms: number): string {
  const totalTenths = Math.max(0, Math.floor(ms / 100));
  const tenths = totalTenths % 10;
  const total = Math.floor(totalTenths / 10);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}.${tenths}`
    : `${pad(minutes)}:${pad(seconds)}.${tenths}`;
}

/** Local wall-clock label for an absolute timestamp. */
export function formatClockTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');

  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
