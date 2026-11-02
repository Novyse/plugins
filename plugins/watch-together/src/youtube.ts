/**
 * A thin wrapper over the YouTube IFrame Player API.
 *
 * The sandbox has no direct video decoding: the player is the YouTube iframe,
 * and the plugin only drives it. Two consequences worth knowing:
 *
 * - the document origin is `file://` on native and opaque on the web, so the
 *   API can refuse to answer. `createPlayer` fails (timeout or script error)
 *   and the UI falls back to a poster with the link, instead of a black box;
 * - a browser may refuse `playVideo()` without a user gesture. The player
 *   reports it, and the UI offers a tap-to-sync control.
 */

interface YouTubeEvent {
  data: number;
  target: YouTubeInstance;
}

interface YouTubeInstance {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YouTubeApi {
  Player: new (
    host: HTMLElement,
    options: Record<string, unknown>,
  ) => YouTubeInstance;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const API_TIMEOUT_MS = 8000;

/** How far the local player may drift before it is corrected, in seconds. */
const DRIFT_TOLERANCE = 1.5;

/** `1` playing, `3` buffering. */
const PLAYING_STATES = new Set([1, 3]);

let api: Promise<YouTubeApi> | null = null;

/**
 * Loads the IFrame API once, and keeps the promise: a second player (there is
 * only one per tile, but a re-render can ask twice) reuses it.
 */
function loadApi(): Promise<YouTubeApi> {
  if (api) return api;

  api = new Promise<YouTubeApi>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    const timer = window.setTimeout(() => {
      reject(new Error('The YouTube player did not answer'));
    }, API_TIMEOUT_MS);

    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);

      if (window.YT?.Player) resolve(window.YT);
      else reject(new Error('The YouTube player is not available'));
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('The YouTube player could not be fetched'));
    };

    document.head.appendChild(script);
  });

  return api;
}

export interface PlayerCallbacks {
  /** The player started or stopped on its own (autoplay, user click). */
  onPlayingChanged?: (playing: boolean) => void;
  /** The player refused the video: embedding disabled, private, removed. */
  onUnavailable?: (code: number) => void;
}

export interface Player {
  load(videoId: string, position: number, playing: boolean): void;
  /** Aligns the player with the room: seeks only when it is off by more than a second. */
  apply(playing: boolean, position: number, currentVideoId: string): void;
  position(): number;
  /** True while the player is actually playing or buffering. */
  playing(): boolean;
  ready(): boolean;
  destroy(): void;
}

class YouTubePlayer implements Player {
  constructor(private readonly player: YouTubeInstance) {}

  ready(): boolean {
    return true;
  }

  playing(): boolean {
    try {
      return PLAYING_STATES.has(Number(this.player.getPlayerState()));
    } catch {
      return false;
    }
  }

  load(videoId: string, position: number, playing: boolean): void {
    this.player.loadVideoById({
      videoId,
      startSeconds: Math.max(0, position),
    });

    if (!playing) {
      // The player starts playing on load: pause as soon as it can.
      window.setTimeout(() => {
        try {
          this.player.pauseVideo();
        } catch {
          // The player was destroyed in the meantime.
        }
      }, 400);
    }
  }

  apply(playing: boolean, position: number, currentVideoId: string): void {
    void currentVideoId;

    const state = Number(this.player.getPlayerState());
    const current = Number(this.player.getCurrentTime()) || 0;

    if (Math.abs(current - position) > DRIFT_TOLERANCE) {
      this.player.seekTo(Math.max(0, position), true);
    }

    const isPlaying = PLAYING_STATES.has(state);

    if (playing && !isPlaying) {
      this.player.playVideo();
      return;
    }

    if (!playing && isPlaying) {
      this.player.pauseVideo();
    }
  }

  position(): number {
    try {
      return Number(this.player.getCurrentTime()) || 0;
    } catch {
      return 0;
    }
  }

  destroy(): void {
    try {
      this.player.destroy();
    } catch {
      // Already gone.
    }
  }
}

/** Creates the player inside `host`, failing when the API cannot be used. */
export function createPlayer(
  host: HTMLElement,
  callbacks: PlayerCallbacks = {},
): Promise<Player> {
  return loadApi().then(
    (yt) =>
      new Promise<Player>((resolve) => {
        const origin = window.location.origin;
        const canDeclareOrigin = origin.startsWith('http');

        const player = new yt.Player(host, {
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            controls: 1,
            ...(canDeclareOrigin ? { origin } : {}),
          },
          events: {
            onReady: () => resolve(new YouTubePlayer(player)),
            onError: (event: YouTubeEvent) => {
              callbacks.onUnavailable?.(event.data);
            },
            onStateChange: (event: YouTubeEvent) => {
              callbacks.onPlayingChanged?.(event.data === 1);
            },
          },
        });
      }),
  );
}
