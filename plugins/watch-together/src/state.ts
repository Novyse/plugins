import type { StateEvent } from '@novyse/app-sdk';

/**
 * The only STATE mutation of the plugin: a complete playback snapshot.
 *
 * One event type carrying the full intent (which source, playing, position)
 * makes the log trivially replayable: the last `PLAYBACK` wins, for a late
 * joiner as well as for a client that missed a few seconds of socket. A
 * different type per action would force every reader to fold a sequence and to
 * get the missing cases right.
 */
export const PLAYBACK = 'PLAYBACK';

export interface YoutubeSource {
  kind: 'youtube';
  /** Canonical watch url, so a late joiner loads the same video. */
  url: string;
  videoId: string;
}

export interface TwitchSource {
  kind: 'twitch';
  url: string;
  /** A channel is live; a video is a VOD and has a position. */
  channel: string | null;
  video: string | null;
  live: boolean;
}

export interface FileSource {
  kind: 'file';
  /** Played by the app, with media_kit: the sandbox cannot decode it. */
  url: string;
}

export type Source = YoutubeSource | TwitchSource | FileSource;

export interface Playback {
  source: Source;
  playing: boolean;
  position: number;
}

export interface PlaybackSnapshot extends Playback {
  /** Server time of the event, used to extrapolate the position. */
  updatedAt: number;
  /** Sequence number of the event: the echo of a local write carries it too. */
  seq: number;
}

export type DetectionReason = 'empty' | 'invalid' | 'insecure';

export type Detection =
  | { ok: true; source: Source }
  | { ok: false; reason: DetectionReason };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extensions the native player can open. The list is about recognising a link,
 * not about decoding it: mpv decides that, at open time.
 */
const FILE_PATH = /\.(mp4|webm|m4v|mkv|ogv|mov)$/i;

/** Twitch paths that are pages, not a channel. */
const TWITCH_RESERVED = new Set([
  'collections',
  'directory',
  'downloads',
  'drops',
  'friends',
  'inventory',
  'jobs',
  'legal',
  'p',
  'partners',
  'privacy',
  'search',
  'settings',
  'store',
  'subscriptions',
  'turbo',
  'videos',
  'wallet',
]);

/**
 * Reads what the user pasted.
 *
 * Order matters: a YouTube link is also a valid `https` url, and a Twitch clip
 * is neither a channel nor a video, so each platform claims its own host before
 * the extension check has a chance to accept anything.
 */
export function detect(input: string): Detection {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'empty' };

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'invalid' };
  }

  const videoId = youtubeId(url);
  if (videoId) {
    return {
      ok: true,
      source: {
        kind: 'youtube',
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      },
    };
  }

  const twitch = twitchSource(url);
  if (twitch) return { ok: true, source: twitch };

  if (FILE_PATH.test(url.pathname)) {
    // The file is streamed by the app, not by the sandbox: https only.
    if (url.protocol !== 'https:') return { ok: false, reason: 'insecure' };

    return { ok: true, source: { kind: 'file', url: url.toString() } };
  }

  return { ok: false, reason: 'invalid' };
}

function youtubeId(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');

  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && YOUTUBE_ID.test(id) ? id : null;
  }

  if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;

  const query = url.searchParams.get('v');
  if (query && YOUTUBE_ID.test(query)) return query;

  const parts = url.pathname.split('/').filter(Boolean);
  const marker = parts.findIndex((part) =>
    ['embed', 'shorts', 'live', 'v'].includes(part),
  );
  const candidate = marker >= 0 ? parts[marker + 1] : undefined;

  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null;
}

function twitchSource(url: URL): TwitchSource | null {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'twitch.tv' && host !== 'm.twitch.tv') return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const head = parts[0]?.toLowerCase() ?? '';

  if ((head === 'videos' || head === 'video') && parts[1] && /^\d+$/.test(parts[1])) {
    return {
      kind: 'twitch',
      url: `https://www.twitch.tv/videos/${parts[1]}`,
      channel: null,
      video: parts[1],
      live: false,
    };
  }

  // Only `/<channel>`: `/about`, `/schedule` and `/clip/...` are pages.
  if (parts.length === 1 && /^[A-Za-z0-9_]{1,25}$/.test(head) && !TWITCH_RESERVED.has(head)) {
    return {
      kind: 'twitch',
      url: `https://www.twitch.tv/${parts[0]}`,
      channel: parts[0],
      video: null,
      live: true,
    };
  }

  return null;
}

/** The last snapshot in the log, `null` when nothing was ever loaded. */
export function latestPlayback(events: StateEvent[]): PlaybackSnapshot | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const snapshot = playbackFromEvent(events[index]);
    if (snapshot) return snapshot;
  }

  return null;
}

/**
 * One event, as a snapshot.
 *
 * Everything coming from the wire is validated: the log is shared with the
 * other clients of the room, and a snapshot missing its source would leave the
 * tile on a black screen with no way back.
 */
export function playbackFromEvent(event: StateEvent): PlaybackSnapshot | null {
  if (event.type !== PLAYBACK) return null;

  const data = event.data as Partial<Playback> | null;
  const source = normalizeSource(data?.source);

  if (!source) return null;

  const position = Number(data?.position);

  return {
    source,
    playing: Boolean(data?.playing),
    position: Number.isFinite(position) ? Math.max(0, position) : 0,
    updatedAt: event.ts,
    seq: event.seq,
  };
}

function normalizeSource(raw: unknown): Source | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const url = typeof candidate.url === 'string' ? candidate.url : '';

  if (!url.startsWith('https://')) return null;

  if (candidate.kind === 'youtube') {
    const videoId = typeof candidate.videoId === 'string' ? candidate.videoId : '';
    return YOUTUBE_ID.test(videoId) ? { kind: 'youtube', url, videoId } : null;
  }

  if (candidate.kind === 'twitch') {
    const channel =
      typeof candidate.channel === 'string' && candidate.channel
        ? candidate.channel
        : null;
    const video =
      typeof candidate.video === 'string' && candidate.video ? candidate.video : null;

    if (!channel && !video) return null;

    return { kind: 'twitch', url, channel, video, live: channel !== null && video === null };
  }

  if (candidate.kind === 'file') return { kind: 'file', url };

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
