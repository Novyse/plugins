/**
 * The official Twitch embed.
 *
 * Twitch has no plain iframe API: a bare `player.twitch.tv` frame is
 * cross-origin and gives the page nothing to drive, so a room could share the
 * channel and never sync a pause. The embed script is still the official
 * player, with the official UI, but it hands the page a `Twitch.Player` with
 * play/pause/seek and events.
 *
 * Two constraints come with it:
 *
 * - `parent` is mandatory and must name the domain that hosts the frame. On
 *   native the document is served from `http://127.0.0.1:<port>`, which Twitch
 *   accepts for local development; on the web the sandbox lives in an opaque
 *   document, so the ancestor has to be read from the referrer. No domain, no
 *   embed, and the UI says so;
 * - a channel is live: there is no position to sync, only play and pause. A
 *   VOD (`/videos/<id>`) behaves like a video.
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
import type { TwitchSource } from './state';

interface TwitchPlayer {
  addEventListener(name: string, callback: () => void): void;
  getCurrentTime(): number;
  isPaused(): boolean;
  pause(): void;
  play(): void;
  seek(seconds: number): void;
  setMuted?(muted: boolean): void;
  getMuted?(): boolean;
}

type TwitchPlayerConstructor = {
  new (
    target: string | HTMLElement,
    options: Record<string, unknown>,
  ): TwitchPlayer;
  READY: string;
  PLAY: string;
  PAUSE: string;
  SEEK: string;
  ENDED: string;
};

interface TwitchApi {
  Player: TwitchPlayerConstructor;
}

declare global {
  interface Window {
    Twitch?: TwitchApi;
  }
}

const SCRIPT_URL = 'https://embed.twitch.tv/embed/v1.js';

let api: Promise<TwitchApi> | null = null;

function loadApi(): Promise<TwitchApi> {
  if (api) return api;

  api = new Promise<TwitchApi>((resolve, reject) => {
    if (window.Twitch?.Player) {
      resolve(window.Twitch);
      return;
    }

    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;

    const timer = window.setTimeout(() => {
      reject(new EmbedError('twitch-no-answer'));
    }, API_TIMEOUT_MS);

    script.onload = () => {
      window.clearTimeout(timer);

      if (window.Twitch?.Player) resolve(window.Twitch);
      else reject(new EmbedError('twitch-not-available'));
    };

    script.onerror = () => {
      window.clearTimeout(timer);
      reject(new EmbedError('twitch-fetch-failed'));
    };

    document.head.appendChild(script);
  });

  return api;
}

/**
 * The domains Twitch may see above its frame.
 *
 * On native the document host is the loopback server of the app; on the web it
 * is usually empty (`about:srcdoc`), and the only trace of the real page is the
 * referrer. When neither is there, Twitch cannot be embedded at all: guessing
 * would only make the iframe render its own error page.
 */
function parentDomains(): string[] {
  const domains = new Set<string>();
  const hostname = window.location.hostname;

  if (hostname) domains.add(hostname);

  if (hostname === '127.0.0.1' || hostname === 'localhost') {
    // Twitch matches the ancestor against the list: declare both spellings.
    domains.add('127.0.0.1');
    domains.add('localhost');
  }

  try {
    if (document.referrer) {
      const referrer = new URL(document.referrer).hostname;
      if (referrer) domains.add(referrer);
    }
  } catch {
    // The referrer is not a url: nothing to declare.
  }

  return [...domains];
}

class TwitchEmbed implements Embed {
  private appliedAt = 0;
  /** What the plugin last asked the player to do: its echo is not an intent. */
  private targetPlaying = false;
  /** Last time the user asked for something: the room must not undo it yet. */
  private intentAt = 0;
  private loaded = false;
  private listening = false;
  /** Last position seen while playing, to tell a seek from normal progress. */
  private observedAt = 0;
  private observedPosition = 0;
  /** Last time the player made progress: the Twitch API can claim "playing"
   * while the browser has blocked the actual media element. */
  private progressAt = 0;
  private progressPosition = 0;
  private wakeAt = 0;
  /** A programmatic seek can make the player emit a pause: not a user click. */
  private seekAt = 0;
  /** The player starts muted so programmatic playback is never autoplay-blocked. */
  private unmuted = false;
  private unmuteTimer = 0;

  constructor(
    private readonly player: TwitchPlayer,
    private readonly source: TwitchSource,
    private readonly callbacks: EmbedCallbacks,
  ) {}

  /** Wires the intent events, once. READY is handled by the factory. */
  listen(): void {
    if (this.listening) return;

    const api = window.Twitch?.Player;
    if (!api) return;

    this.listening = true;

    this.player.addEventListener(api.PLAY, () => this.intent(true));
    this.player.addEventListener(api.PAUSE, () => this.intent(false));
    this.player.addEventListener(api.SEEK, () => this.intentSeek());
    this.player.addEventListener(api.ENDED, () => this.intent(false));
  }

  load(position: number, playing: boolean): void {
    this.loaded = true;
    this.targetPlaying = playing;

    if (!this.source.live && Math.abs(this.position() - position) > 1) {
      this.seekTo(position);
    }
    // When the room was already playing, the player was created with
    // autoplay and is running muted: `watchProgress` restores the audio as
    // soon as the media really advances.
  }

  apply(playing: boolean): void {
    // A click on the player must not be undone while its snapshot travels
    // through the room: that holds for a moment, then the log wins again.
    if (Date.now() - this.intentAt < INTENT_HOLD_MS) return;

    const isPlaying = this.playing();

    if (playing && isPlaying) {
      this.watchProgress();
      return;
    }

    if (playing === isPlaying) return;

    this.targetPlaying = playing;
    if (playing) this.play();
    else this.pause();
  }

  seek(position: number): void {
    if (!this.source.live) this.seekTo(position);
  }

  state(): { playing: boolean; position: number } {
    return { playing: this.playing(), position: this.position() };
  }

  tick(): void {
    if (!this.loaded || this.source.live) return;
    if (Date.now() - this.appliedAt < APPLY_HOLD_MS) return;

    // A jump is measured against the previous sample, not against the room:
    // buffering pushes the room clock forward, but it does not move the video.
    const now = Date.now();

    if (!this.playing()) {
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

    if (jumped) this.callbacks.onIntent(true, actual);

    this.observedAt = now;
    this.observedPosition = actual;
  }

  /** A live player reports a stream time, not a position in the video. */
  position(): number {
    if (this.source.live) return 0;

    try {
      return Number(this.player.getCurrentTime()) || 0;
    } catch {
      return 0;
    }
  }

  playing(): boolean {
    try {
      return !this.player.isPaused();
    } catch {
      return false;
    }
  }

  /**
   * Starts playback even when the browser would block a programmatic play.
   *
   * The player is created muted, so autoplay is always allowed; audio is
   * restored once the media is actually running. Twitch also reports
   * `isPaused() === false` as soon as it *wants* to play, even when the media
   * element is still blocked, so the watchdog in `watchProgress` is the final
   * safety net.
   */
  private play(): void {
    this.appliedAt = Date.now();
    this.observedAt = 0;
    this.progressAt = Date.now();
    this.progressPosition = this.rawPosition();

    try {
      this.player.play();
      this.scheduleUnmute();
    } catch {
      // Blocked until the user taps the player.
    }
  }

  private scheduleUnmute(): void {
    if (this.unmuted) return;

    window.clearTimeout(this.unmuteTimer);
    this.unmuteTimer = window.setTimeout(() => {
      if (!this.targetPlaying || this.unmuted) return;

      try {
        this.player.setMuted?.(false);
        this.unmuted = true;
      } catch {
        // The player was destroyed in the meantime.
      }
    }, 800);
  }

  private pause(): void {
    this.appliedAt = Date.now();
    this.observedAt = 0;

    try {
      this.player.pause();
    } catch {
      // The player was destroyed in the meantime.
    }
  }

  private seekTo(position: number): void {
    this.appliedAt = Date.now();
    this.seekAt = Date.now();
    this.observedAt = 0;

    try {
      this.player.seek(Math.max(0, position));
    } catch {
      // Not ready: the next tick will align it.
    }
  }

  /** The stream time, even on a live channel, for the stall watchdog. */
  private rawPosition(): number {
    try {
      return Number(this.player.getCurrentTime()) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Twitch can claim to be playing while the media element stays paused after
   * an autoplay block or a seek. If the time does not move, retry a muted play.
   */
  private watchProgress(): void {
    const now = Date.now();
    const current = this.rawPosition();

    if (Math.abs(current - this.progressPosition) > 0.05) {
      this.progressPosition = current;
      this.progressAt = now;
      if (this.targetPlaying) this.scheduleUnmute();
      return;
    }

    if (now - this.progressAt < 3500) return;
    if (now - this.wakeAt < 5000) return;

    this.wakeAt = now;
    this.progressAt = now;
    this.play();
  }

  /**
   * The player confirming what was asked of it is not an intent. A transition
   * in the opposite direction is the user touching the player, even if it
   * happens right after a programmatic command.
   */
  private intent(playing: boolean): void {
    if (!this.loaded || playing === this.targetPlaying) return;

    // A seek can make Twitch pause for a moment. That is not a user pause;
    // applying it would write `false` to the room and freeze every player.
    if (!playing && Date.now() - this.seekAt < APPLY_HOLD_MS) return;

    this.targetPlaying = playing;
    this.intentAt = Date.now();
    if (playing) this.scheduleUnmute();
    this.callbacks.onIntent(playing, this.position());
  }

  /** A seek has no play/pause transition to compare: ignore our own seek. */
  private intentSeek(): void {
    if (!this.loaded) return;
    if (Date.now() - this.appliedAt < APPLY_HOLD_MS) return;

    this.intentAt = Date.now();
    this.callbacks.onIntent(this.playing(), this.position());
  }

  destroy(): void {
    // The embed has no teardown: the catcher removes its own element.
    window.clearTimeout(this.unmuteTimer);
  }
}

/**
 * Creates the player inside `host`.
 *
 * The script wants an element id, so a child is created for it: the host div
 * belongs to the layout and must not be replaced by the iframe.
 */
export function createTwitch(
  host: HTMLElement,
  source: TwitchSource,
  callbacks: EmbedCallbacks,
  initialPlaying: boolean,
): Promise<Embed> {
  const parents = parentDomains();

  if (parents.length === 0) {
    return Promise.reject(new EmbedError('twitch-no-domain'));
  }

  return loadApi().then(
    (twitch) =>
      new Promise<Embed>((resolve, reject) => {
        const target = document.createElement('div');
        target.id = `twitch-${Math.random().toString(36).slice(2, 9)}`;
        target.style.height = '100%';
        host.appendChild(target);

        const player = new twitch.Player(target.id, {
          ...(source.channel ? { channel: source.channel } : { video: source.video }),
          parent: parents,
          autoplay: initialPlaying,
          muted: true,
          width: '100%',
          height: '100%',
        });

        const embed = new TwitchEmbed(player, source, callbacks);

        let ready = false;

        player.addEventListener(twitch.Player.READY, () => {
          if (ready) return;

          ready = true;
          embed.listen();
          resolve(embed);
          callbacks.onReady();
        });

        window.setTimeout(() => {
          if (ready) return;
          reject(new EmbedError('twitch-no-answer'));
        }, API_TIMEOUT_MS);
      }),
  );
}
