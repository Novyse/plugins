/**
 * A thin wrapper over the YouTube IFrame Player API.
 *
 * The sandbox has no decoder: the player is the YouTube iframe, and the plugin
 * only drives it. Two consequences worth knowing:
 *
 * - the document origin is `http://127.0.0.1:<port>` on native and opaque on
 *   the web, so the API can refuse to answer. `createYouTube` fails (timeout or
 *   script error) and the UI says so instead of showing a black box;
 * - a browser may refuse `playVideo()` without a user gesture. Nothing is
 *   forced: the room keeps playing and the local user taps play on the player
 *   itself, whose event is then published like any other intent.
 *
 * The video is passed when the player is created, not loaded afterwards: the
 * API then builds `/embed/<id>?...`, which is the path it has been tested on
 * for years. A player created empty and fed with `loadVideoById` answers, but
 * does not always buffer: the tile shows the poster and never starts.
 */
import {
  API_TIMEOUT_MS,
  APPLY_HOLD_MS,
  EmbedError,
  INTENT_HOLD_MS,
  SEEK_INTENT,
  type Embed,
  type EmbedCallbacks,
} from './embed';
import type { YoutubeSource } from './state';

interface YouTubeEvent {
  data: number;
  target: YouTubeInstance;
}

interface YouTubeInstance {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
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

/** The only state in which the video is really moving. */
const PLAYING = 1;

/** A player that is loading or buffering: leave it alone until it settles. */
const BUFFERING = 3;

/** `2` paused, `0` ended. */
const STOPPED_STATES = new Set([0, 2]);

let api: Promise<YouTubeApi> | null = null;

/** Loads the IFrame API once, and keeps the promise for the next player. */
function loadApi(): Promise<YouTubeApi> {
  if (api) return api;

  api = new Promise<YouTubeApi>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    const timer = window.setTimeout(() => {
      reject(new EmbedError('youtube-no-answer'));
    }, API_TIMEOUT_MS);

    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);

      if (window.YT?.Player) resolve(window.YT);
      else reject(new EmbedError('youtube-not-available'));
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new EmbedError('youtube-fetch-failed'));
    };

    document.head.appendChild(script);
  });

  return api;
}

class YouTubeEmbed implements Embed {
  /** Last time the plugin moved the player: `tick` must not read that as a seek. */
  private appliedAt = 0;
  /** What the room last asked for: a matching state change is not a user action. */
  private targetPlaying = false;
  /** Last time the user asked for something: the room must not undo it yet. */
  private intentAt = 0;
  private loaded = false;
  /** Last position seen while playing, to tell a seek from normal progress. */
  private observedAt = 0;
  private observedPosition = 0;

  constructor(
    private readonly player: YouTubeInstance,
    private readonly callbacks: EmbedCallbacks,
  ) {}

  load(position: number, playing: boolean): void {
    this.loaded = true;
    this.targetPlaying = playing;

    // A live stream has no position to go to, and seeking to second 0 of a
    // stream that started hours ago is exactly the black screen.
    if (position >= 1 && !this.live()) this.seekTo(position);

    if (playing) this.play();
  }

  apply(playing: boolean): void {
    if (Date.now() - this.intentAt < INTENT_HOLD_MS) return;

    const state = this.playerState();

    // A player that is buffering is on its way to play: pausing it here is
    // what turns a click on the video into a black frame. Leave the target
    // alone too, since the command that started the buffering is still it.
    if (state === BUFFERING) return;

    this.targetPlaying = playing;

    const isPlaying = state === PLAYING;
    if (playing === isPlaying) return;

    if (playing) this.play();
    else this.pause();
  }

  seek(position: number): void {
    if (!this.live()) this.seekTo(position);
  }

  state(): { playing: boolean; position: number } {
    return { playing: this.playerState() === PLAYING, position: this.position() };
  }

  tick(): void {
    if (!this.loaded || this.live()) return;
    if (Date.now() - this.appliedAt < APPLY_HOLD_MS) return;

    // A jump is measured against the previous sample, not against the room:
    // buffering pushes the room clock forward, but it does not move the video.
    const now = Date.now();
    const state = this.playerState();

    // Keep the previous sample across buffering: that is exactly where a seek
    // made with the player's controls spends its time.
    if (state === BUFFERING) return;

    if (state !== PLAYING) {
      this.observedAt = 0;
      return;
    }

    const actual = this.position();

    if (!this.observedAt) {
      this.observedAt = now;
      this.observedPosition = actual;
      return;
    }

    const elapsed = (now - this.observedAt) / 1000;
    const progress = actual - this.observedPosition;
    const jumped =
      Math.abs(progress) > SEEK_INTENT &&
      Math.abs(progress - elapsed) > SEEK_INTENT;

    if (jumped) this.report(true, actual);

    this.observedAt = now;
    this.observedPosition = actual;
  }

  /** A state change reported by the player, i.e. possibly a user action. */
  intentFrom(state: number): void {
    if (!this.loaded) return;

    // The player confirming what was just asked of it is not an intent: only
    // the opposite transition is the user touching the player.
    if (state === PLAYING && !this.targetPlaying) {
      this.report(true, this.position());
    } else if (STOPPED_STATES.has(state) && this.targetPlaying) {
      this.report(false, this.position());
    }
  }

  /** The player is on a live stream (no duration), not on a video. */
  private live(): boolean {
    try {
      return !(Number(this.player.getDuration()) > 0);
    } catch {
      // Not ready: not a position to seek to either.
      return true;
    }
  }

  position(): number {
    if (this.live()) return 0;

    try {
      return Number(this.player.getCurrentTime()) || 0;
    } catch {
      return 0;
    }
  }

  private playerState(): number {
    try {
      return Number(this.player.getPlayerState());
    } catch {
      return -1;
    }
  }

  private play(): void {
    this.appliedAt = Date.now();
    this.observedAt = 0;

    try {
      this.player.playVideo();
    } catch {
      // Blocked until the user taps the player.
    }
  }

  private pause(): void {
    this.appliedAt = Date.now();
    this.observedAt = 0;

    try {
      this.player.pauseVideo();
    } catch {
      // The player was destroyed in the meantime.
    }
  }

  private seekTo(position: number): void {
    this.appliedAt = Date.now();
    this.observedAt = 0;

    try {
      this.player.seekTo(Math.max(0, position), true);
    } catch {
      // Not ready: the next tick will align it.
    }
  }

  private report(playing: boolean, position: number): void {
    this.targetPlaying = playing;
    this.intentAt = Date.now();
    this.callbacks.onIntent(playing, position);
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
export function createYouTube(
  host: HTMLElement,
  source: YoutubeSource,
  callbacks: EmbedCallbacks,
): Promise<Embed> {
  return loadApi().then(
    (yt) =>
      new Promise<Embed>((resolve, reject) => {
        // The API replaces the element it is given with its iframe. Handing it
        // a child keeps the host div of the layout (and the diffing above it)
        // intact, and gives `destroy()` something that can be removed whole.
        const target = document.createElement('div');
        target.style.width = '100%';
        target.style.height = '100%';
        host.appendChild(target);

        const origin = window.location.origin;
        const canDeclareOrigin = origin.startsWith('http');
        let embed: YouTubeEmbed | null = null;
        let player: YouTubeInstance;

        try {
          player = new yt.Player(target, {
            width: '100%',
            height: '100%',
            videoId: source.videoId,
            playerVars: {
              autoplay: 0,
              playsinline: 1,
              rel: 0,
              modestbranding: 1,
              controls: 1,
              ...(canDeclareOrigin ? { origin } : {}),
            },
            events: {
              onReady: () => {
                embed = new YouTubeEmbed(player, callbacks);
                resolve(embed);
                callbacks.onReady();
              },
              onError: (event: YouTubeEvent) => {
                callbacks.onError(new EmbedError('youtube-refused', Number(event.data)));
              },
              onStateChange: (event: YouTubeEvent) => {
                embed?.intentFrom(Number(event.data));
              },
            },
          });
        } catch (cause) {
          target.remove();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
          return;
        }

        window.setTimeout(() => {
          if (embed) return;
          reject(new EmbedError('youtube-no-answer'));
        }, API_TIMEOUT_MS);
      }),
  );
}
