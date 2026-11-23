import type { StateEvent } from '@novyse/app-sdk';

/**
 * The only STATE mutation of the activity: a complete timer snapshot.
 *
 * One event type carrying the full intent (mode, duration, remaining, running)
 * makes the log trivially replayable: the last `TIMER` wins for a late joiner,
 * and a client that missed a few seconds computes the same countdown from `ts`
 * and the server clock.
 */
export const TIMER = 'TIMER';

export type Phase = 'focus' | 'short';

export const PHASES: readonly Phase[] = ['focus', 'short'];

/** Length of each mode, in milliseconds, as saved on this device. */
export interface Durations {
  focus: number;
  short: number;
}

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

/** 99:59:59, the ceiling of the inline duration editor. */
export const MAX_DURATION_MS = 99 * 60 * MINUTE + 59 * MINUTE + 59 * SECOND;

export const MIN_DURATION_MS = SECOND;

export const DEFAULT_DURATIONS: Durations = {
  focus: 25 * MINUTE,
  short: 5 * MINUTE,
};

export interface TimerSnapshot {
  phase: Phase;
  /** Length of the mode this snapshot belongs to. */
  durationMs: number;
  /** Time left at `ts`; while running, subtract the elapsed time from it. */
  remainingMs: number;
  running: boolean;
}

export interface TimerAnchor extends TimerSnapshot {
  seq: number;
  /** Server time of the event, used to extrapolate the countdown. */
  at: number;
}

export function isPhase(value: unknown): value is Phase {
  return value === 'focus' || value === 'short';
}

function clampDuration(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;

  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(value)));
}

/** Durations read from local storage, with every field clamped. */
export function normalizeDurations(raw: unknown): Durations {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  return {
    focus: clampDuration(Number(data.focus), DEFAULT_DURATIONS.focus),
    short: clampDuration(Number(data.short), DEFAULT_DURATIONS.short),
  };
}

/**
 * Everything coming from the wire is validated: the log is shared with the
 * other clients of the room, and a snapshot with a broken mode would leave
 * the tile on an unusable countdown.
 */
export function normalizeSnapshot(raw: unknown): TimerSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;

  const data = raw as Record<string, unknown>;
  if (!isPhase(data.phase)) return null;

  const durationMs = clampDuration(Number(data.durationMs), DEFAULT_DURATIONS[data.phase]);
  const remaining = Number(data.remainingMs);
  const remainingMs = Number.isFinite(remaining)
    ? Math.min(durationMs, Math.max(0, Math.round(remaining)))
    : durationMs;

  return {
    phase: data.phase,
    durationMs,
    remainingMs,
    running: data.running === true,
  };
}

/** The last snapshot in the log, `null` when no timer was ever published. */
export function latestTimer(events: StateEvent[]): TimerAnchor | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== TIMER) continue;

    const snapshot = normalizeSnapshot(event.data);
    if (snapshot) return { ...snapshot, seq: event.seq, at: event.ts };
  }

  return null;
}

/**
 * Time left right now.
 *
 * A paused timer keeps its stored remaining time; a running one subtracts the
 * server time elapsed since the event. The server clock is the authority, so
 * a client whose own clock is skewed still lands on the same second.
 */
export function remainingAt(anchor: TimerAnchor | null, serverNow: number): number {
  if (!anchor) return DEFAULT_DURATIONS.focus;
  if (!anchor.running) return anchor.remainingMs;

  return Math.max(0, anchor.remainingMs - Math.max(0, serverNow - anchor.at));
}

/** `MM:SS`, or `H:MM:SS` once the timer passes an hour. */
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
