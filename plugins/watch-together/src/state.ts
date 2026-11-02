import type { StateEvent } from '@novyse/app-sdk';

/**
 * The only STATE mutation of the plugin: a complete playback snapshot.
 *
 * One event type carrying the full intent (`videoId`, `playing`, `position`)
 * makes the log trivially replayable: the last `PLAYBACK` wins, for a late
 * joiner as well as for a client that missed a few seconds of socket. The
 * alternative — a different type per action — forces every reader to
 * reconstruct the state by folding a sequence, and to get the missing cases
 * right.
 */
export const PLAYBACK = 'PLAYBACK';

export interface Playback {
  videoId: string;
  playing: boolean;
  position: number;
}

export interface PlaybackSnapshot extends Playback {
  /** Server time of the event, used to extrapolate the position. */
  updatedAt: number;
}

/** The last snapshot in the log, `null` when nothing was ever loaded. */
export function latestPlayback(events: StateEvent[]): PlaybackSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event.type !== PLAYBACK) continue;

    const data = event.data as Playback | null;
    if (!data?.videoId) return null;

    return {
      videoId: data.videoId,
      playing: Boolean(data.playing),
      position: Number.isFinite(data.position) ? Math.max(0, data.position) : 0,
      updatedAt: event.ts,
    };
  }

  return null;
}

/**
 * Where the video should be, right now.
 *
 * The position stored in the event is the one at `updatedAt`: while playing,
 * the real position is that plus the time elapsed since, measured on the
 * server clock so a client with a skewed clock does not drag the room.
 */
export function positionAt(snapshot: PlaybackSnapshot | null, now: number): number {
  if (!snapshot) return 0;
  if (!snapshot.playing) return snapshot.position;

  return snapshot.position + Math.max(0, (now - snapshot.updatedAt) / 1000);
}

const ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extracts the video id from a YouTube URL, or from a bare id.
 *
 * Supports `watch?v=`, `youtu.be/`, `embed/`, `shorts/`, `live/`, with or
 * without a mobile or `www` prefix; anything else is rejected instead of being
 * passed to the player.
 */
export function parseVideoId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ID.test(raw)) return raw;

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && ID.test(id) ? id : null;
  }

  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;

  const fromQuery = url.searchParams.get('v');
  if (fromQuery && ID.test(fromQuery)) return fromQuery;

  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.findIndex((part) => part === 'embed' || part === 'shorts' || part === 'live');
  const candidate = marker >= 0 ? parts[marker + 1] : undefined;

  return candidate && ID.test(candidate) ? candidate : null;
}

/** `88` → `1:28`, `3725` → `1:02:05`. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}
