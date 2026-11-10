/**
 * A thin wrapper over the YouTube IFrame Player API.
 *
 * The sandbox has no decoder: the player is the YouTube iframe, and the plugin
 * only drives it. Two consequences worth knowing:
 *
 * - the document origin is `http://127.0.0.1:<port>` on native and opaque on
 *   the web, so the API can refuse to answer. `createYouTube` fails (timeout or
 *   script error) and the UI says so instead of showing a black box;
 * - a browser refuses a `playVideo()` that no gesture asked for, and that is
 *   exactly the call a receiver makes. Nothing is forced: the room keeps
 *   playing, the local player stays where it is, and one tap on it starts that
 *   client.
 *
 * The video is passed when the player is created, not loaded afterwards: the
 * API then builds `/embed/<id>?...`, which is the path it has been tested on
 * for years. A player created empty and fed with `loadVideoById` answers, but
 * does not always buffer: the tile shows the poster and never starts.
 */
import {
  APPLY_HOLD_MS,
  EmbedError,
  INTENT_HOLD_MS,
  SEEK_INTENT,
  SEEK_TOLERANCE,
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

/**
 * How long after a load the player is left alone, in ms.
 *
 * Some platforms start the iframe by themselves while it mounts: publishing
 * that as an intent is what turned a paused room into a playing one for every
 * participant the moment someone opened the activity.
 */
const SETTLE_MS = 2_500;

/** A player that is loading or buffering: leave it alone until it settles. */
const BUFFERING = 3;

/** `2` paused, `0` ended. */
const STOPPED_STATES = new Set([0, 2]);

let api: Promise<YouTubeApi> | null = null;

/**
 * Loads the IFrame API once, and keeps the promise for the next player.
 *
 * There is no deadline of our own: a script that cannot be fetched fires
 * `onerror`, and one that is fetched either defines `YT.Player` or calls the
 * global callback. Waiting for one of those two is exact — a guessed duration
 * only turned a slow network into an error the user could not act on.
 */
function loadApi(): Promise<YouTubeApi> {
  if (api) return api;

  api = new Promise<YouTubeApi>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }

    // Assigned before the script is appended, so the API cannot call it before
    // this page is listening.
    window.onYouTubeIframeAPIReady = () => {
      if (window.YT?.Player) resolve(window.YT);
      else reject(new EmbedError('youtube-not-available'));
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;

    // A blocked or unreachable script (offline, policy, DNS) says so here; one
    // that arrives is followed by the callback above.
    script.onerror = () => reject(new EmbedError('youtube-fetch-failed'));

    document.head.appendChild(script);
  }).catch((cause: unknown) => {
    // A failed load must not poison the next attempt: the next player retries
    // the script instead of inheriting this rejection.
    api = null;

    throw cause;
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
  /** Until this moment a state change is the player loading, not a user. */
  private settleUntil = 0;
  /** Last sample, to tell a seek from normal progress. */
  private observedAt = 0;
  private observedPosition = 0;
  private observedPlaying = false;

  constructor(
    private readonly player: YouTubeInstance,
    private readonly callbacks: EmbedCallbacks,
    private readonly locked = false,
  ) {}

  load(position: number, playing: boolean): void {
    this.loaded = true;
    this.targetPlaying = playing;
    this.settleUntil = Date.now() + SETTLE_MS;

    // A live stream has no position to go to, and seeking to second 0 of a
    // stream that started hours ago is exactly the black screen.
    if (position >= 1 && !this.live()) this.seekTo(position);

    // Paused by default, then the room decides
    this.pause();

    if (playing) this.play();
  }

  apply(playing: boolean): void {
    if (Date.now() - this.intentAt < INTENT_HOLD_MS) return;

    const state = this.playerState();

    // A player that is buffering is on its way somewhere: pausing it here is
    // what turns a click on the video into a black frame, and it also undoes a
    // play the user just asked for before the player managed to start. A room
    // that is paused gets its pause on the next tick, once the player is
    // actually playing.
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
    if (!this.loaded || this.live() || this.locked) return;
    if (Date.now() - this.appliedAt < APPLY_HOLD_MS) return;

    const now = Date.now();
    const state = this.playerState();

    // A buffering player is not moving, but it is often on its way to the
    // position the user picked with the controls: keeping the previous sample
    // across it is what makes that jump visible when it lands. Resetting the
    // sample here lost the seek, and the next `align` pulled the player back to
    // the time of the room — the video reached 1:40 and jumped back to 7:08.
    if (state === BUFFERING) return;

    const playing = state === PLAYING;
    const actual = this.position();

    if (!this.observedAt) {
      this.observedAt = now;
      this.observedPosition = actual;
      this.observedPlaying = playing;
      return;
    }

    // A jump is measured against the previous sample, not against the room:
    // buffering pushes the room clock forward, but it does not move the video.
    const elapsed =
      playing && this.observedPlaying ? (now - this.observedAt) / 1000 : 0;
    const progress = actual - this.observedPosition;
    const jumped =
      Math.abs(progress) > SEEK_INTENT &&
      Math.abs(progress - elapsed) > SEEK_INTENT;

    // The state of the player, not a fixed `true`: a seek made while the room
    // is paused stays a seek in a paused room instead of starting playback for
    // everyone.
    if (jumped) this.report(playing, actual);

    this.observedAt = now;
    this.observedPosition = actual;
    this.observedPlaying = playing;
  }

  /** A state change reported by the player, i.e. possibly a user action. */
  intentFrom(state: number): void {
    if (!this.loaded || this.locked) return;

    // The player starting by itself while it mounts is not an intent.
    if (Date.now() < this.settleUntil) return;

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
    if (this.locked) return;

    this.targetPlaying = playing;
    this.intentAt = Date.now();
    this.callbacks.onIntent(playing, position);
  }

  align(expected: number): void {
    if (!this.loaded || this.live()) return;
    if (Date.now() - this.intentAt < INTENT_HOLD_MS) return;

    // A buffering player is already on its way somewhere: seeking it now would
    // throw away the buffer it is filling.
    if (this.playerState() === BUFFERING) return;
    if (Math.abs(this.position() - expected) <= SEEK_TOLERANCE) return;

    this.seekTo(expected);
  }

  destroy(): void {
    try {
      this.player.destroy();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Creates the player inside `host`, failing when the API cannot be used.
 *
 * The API is awaited directly: the load reports its own failure, so there is no
 * promise of ours to give up on.
 */
export function createYouTube(
  host: HTMLElement,
  source: YoutubeSource,
  callbacks: EmbedCallbacks,
  locked = false,
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
              controls: locked ? 0 : 1,
              ...(canDeclareOrigin ? { origin } : {}),
            },
            events: {
              onReady: (event: YouTubeEvent) => {
                try {
                  event.target.pauseVideo();
                } catch {
                }

                embed = new YouTubeEmbed(player, callbacks, locked);
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

      }),
  );
}
