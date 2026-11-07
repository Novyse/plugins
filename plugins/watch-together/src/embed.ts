/**
 * Failures of an embed, as a code the UI translates.
 *
 * The embed never builds a sentence: it says what happened, the language of
 * the room decides how to say it.
 */
export type EmbedErrorCode =
  | 'youtube-not-available'
  | 'youtube-fetch-failed'
  | 'youtube-refused'
  | 'twitch-no-domain'
  | 'twitch-not-available'
  | 'twitch-fetch-failed';

export class EmbedError extends Error {
  constructor(
    readonly embedCode: EmbedErrorCode,
    /** The platform code, when the platform gave one. */
    readonly detail?: number,
  ) {
    super(embedCode);
    this.name = 'EmbedError';
  }
}

/**
 * What the plugin needs from an embedded player, whichever platform it is.
 *
 * The sandbox never decodes video: YouTube and Twitch are iframes driven
 * through their own APIs, and a file is handed to the app. This is the seam
 * between the room state and the player, so the same reconciliation runs for
 * both embeds.
 */
export interface EmbedCallbacks {
  /** The player is up and can be told where to go. */
  onReady(): void;
  /** The embed refused the source: private, removed, embedding disabled. */
  onError(error: EmbedError): void;
  /** A playback change made with the controls of the player itself. */
  onIntent(playing: boolean, position: number): void;
}

export interface Embed {
  /** Loads the source at a position; `playing` is the intent of the room. */
  load(position: number, playing: boolean): void;
  /**
   * Aligns play and pause with the room.
   *
   * Play and pause are commands: repeating them is harmless, so they can be
   * applied on every tick. A seek is not, and lives in `align`.
   */
  apply(playing: boolean): void;
  /** Jumps to a position, once, when the room actually asks for it. */
  seek(position: number): void;
  /**
   * Brings the player back to where the room says it is, when it drifted.
   */
  align(expected: number): void;
  state(): { playing: boolean; position: number };
  /** Detects a seek the player made on its own (the APIs have no seek event). */
  tick(): void;
  destroy(): void;
}

/** A jump larger than this is a seek, not buffering, in seconds. */
export const SEEK_INTENT = 2.5;

/** How long a programmatic action is not mistaken for a user one, in ms. */
export const APPLY_HOLD_MS = 1200;

/** How long a play/pause the user asked for is left alone, in ms. */
export const INTENT_HOLD_MS = 2500;

/**
 * How far the local player may be from the room before `align` seeks it, in
 * seconds.
 */
export const SEEK_TOLERANCE = 1.5;
