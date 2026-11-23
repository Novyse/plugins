import type { StateEvent } from '@novyse/app-sdk';

/**
 * One STATE mutation: the whole wheel (options, current spin, winner rule and
 * result history).
 *
 * The spin carries the winning option and its label, not only an index: the
 * winner may be hidden or removed as soon as the result appears, and the card
 * must still name it. The index only drives the animation on the visible
 * slices.
 */
export const WHEEL = 'WHEEL';

export const SPIN_MS = 5200;
export const MAX_OPTIONS = 999;
export const MAX_LABEL = 40;
export const MAX_HISTORY = 50;

export type WinnerMode = 'keep' | 'hide' | 'remove';

export interface WheelOption {
  id: string;
  label: string;
  hidden?: boolean;
}

export interface Spin {
  id: string;
  /** Index among the visible slices, used for the landing angle. */
  index: number;
  /** Id of the winning option, stable even after it is hidden or removed. */
  optionId: string;
  /** Winning label, so the result survives the option mutation. */
  label: string;
  /** Server time the spin started. */
  at: number;
  /** Participant that started the spin; that client applies the winner rule. */
  by?: string;
}

export interface WheelResult {
  id: string;
  label: string;
  /** Server time of the win. */
  at: number;
}

export interface WheelSnapshot {
  options: WheelOption[];
  spin: Spin | null;
  winnerMode: WinnerMode;
  /** Newest first. */
  history: WheelResult[];
}

export interface WheelAnchor extends WheelSnapshot {
  seq: number;
  ts: number;
}

export const DEFAULT_OPTIONS: WheelOption[] = [];

/** Piliapp-like rainbow, repeated with a shift when the options pass twelve. */
const PALETTE = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#d946ef',
  '#ec4899',
];

export function createId(): string {
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  return `opt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function pickIndex(count: number): number {
  if (count <= 1) return 0;

  const values = new Uint32Array(1);
  const cryptoApi = globalThis.crypto;

  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(values);
    return values[0] % count;
  }

  return Math.floor(Math.random() * count);
}

/** Four to six turns before landing, stable for the same spin id. */
export function turnCount(id: string): number {
  let hash = 0;

  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  }

  return 4 + (hash % 3);
}

function sanitizeLabel(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL)
    : '';
}

function sanitizeId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 64) : '';
}

export function normalizeOptions(raw: unknown): WheelOption[] {
  if (!Array.isArray(raw)) return [];

  const options: WheelOption[] = [];
  const seen = new Set<string>();

  for (const [index, item] of raw.entries()) {
    if (options.length >= MAX_OPTIONS) break;

    let id = '';
    let label = '';
    let hidden = false;

    if (typeof item === 'string') {
      label = sanitizeLabel(item);
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      id = sanitizeId(record.id);
      label = sanitizeLabel(record.label);
      hidden = record.hidden === true;
    }

    if (!label) continue;

    if (!id || seen.has(id)) {
      id = `opt-${index}`;
      while (seen.has(id)) id = `${id}-x`;
    }

    seen.add(id);
    options.push({ id, label, ...(hidden ? { hidden: true } : {}) });
  }

  return options;
}

export function normalizeWinnerMode(raw: unknown): WinnerMode {
  return raw === 'hide' || raw === 'remove' ? raw : 'keep';
}

export function normalizeHistory(raw: unknown): WheelResult[] {
  if (!Array.isArray(raw)) return [];

  const results: WheelResult[] = [];
  const seen = new Set<string>();

  for (const [index, item] of raw.entries()) {
    if (results.length >= MAX_HISTORY) break;

    let id = '';
    let label = '';
    let at = 0;

    if (typeof item === 'string') {
      label = sanitizeLabel(item);
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      id = sanitizeId(record.id);
      label = sanitizeLabel(record.label);
      at = Number(record.at);
    }

    if (!label) continue;

    if (!id || seen.has(id)) {
      id = `result-${index}`;
      while (seen.has(id)) id = `${id}-x`;
    }

    seen.add(id);
    results.push({ id, label, at: Number.isFinite(at) ? at : 0 });
  }

  return results;
}

export function normalizeSnapshot(raw: unknown): WheelSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;

  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.options)) return null;

  const options = normalizeOptions(data.options);
  const visible = options.filter((option) => !option.hidden);
  const winnerMode = normalizeWinnerMode(data.winnerMode);
  const history = normalizeHistory(data.history);
  let spin: Spin | null = null;
  const rawSpin = data.spin;

  if (rawSpin && typeof rawSpin === 'object') {
    const record = rawSpin as Record<string, unknown>;
    const rawIndex = Number(record.index);
    const index = Number.isInteger(rawIndex)
      ? Math.min(999, Math.max(0, rawIndex))
      : 0;
    const fallback = visible[index];
    const label = sanitizeLabel(record.label) || fallback?.label || '';
    const optionId = sanitizeId(record.optionId) || fallback?.id || '';
    const at = Number(record.at);
    const id = sanitizeId(record.id);
    const by = sanitizeId(record.by);

    if (label) {
      spin = {
        id: id || `spin-${index}`,
        index,
        optionId,
        label,
        at: Number.isFinite(at) ? at : 0,
        ...(by ? { by } : {}),
      };
    }
  }

  return { options, spin, winnerMode, history };
}

/**
 * One event, with the pieces the network may omit filled in: the id from the
 * sequence number and the start time from the server timestamp. The start is
 * clamped around `ts`: the sender's optimistic clock is close, a hostile one
 * is not allowed to freeze the animation.
 */
export function wheelFromEvent(event: StateEvent): WheelAnchor | null {
  const snapshot = normalizeSnapshot(event.data);
  if (!snapshot) return null;

  let spin = snapshot.spin;

  if (spin) {
    const at = spin.at
      ? Math.min(event.ts + 2000, Math.max(event.ts - 5000, spin.at))
      : event.ts;

    spin = { ...spin, id: spin.id || `spin-${event.seq}`, at };
  }

  return { ...snapshot, spin, seq: event.seq, ts: event.ts };
}

export function latestWheel(events: StateEvent[]): WheelAnchor | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const anchor = wheelFromEvent(events[index]);
    if (anchor) return anchor;
  }

  return null;
}

export function colorAt(index: number): string {
  const base = PALETTE[index % PALETTE.length];
  const cycle = Math.floor(index / PALETTE.length);

  if (cycle === 0) return base;

  return shade(base, cycle % 2 === 0 ? 1.15 : 0.78);
}

function shade(hex: string, factor: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];

  return `#${channels
    .map((channel) =>
      Math.min(255, Math.max(0, Math.round(channel * factor)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Dark ink on the bright slices, white on the deep ones. */
export function textColorFor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;

  return luminance > 0.62 ? '#0b1220' : '#ffffff';
}
