import type { ThemeColors, ThemeMode, ThemeState } from './theme';

/**
 * The contract between a plugin and the Novyse host.
 *
 * The host injects `window.AppSDK` into the document before the plugin runs.
 * These are types only: the implementation lives in the app (Flutter), and the
 * development host in `./dev-host` stands in for it while working offline.
 *
 * Three channels, three different guarantees:
 *
 * - `state`  persistent. The server assigns `seq` and `ts`, appends the event
 *            to the log of the activity and replays the log to late joiners.
 *            Use it for anything a newcomer must see.
 * - `action` transient but reliable. Reaches whoever is in the room now, never
 *            replayed. Use it for sounds, animations, one-off feedback.
 * - `stream` lossy, unthrottled, direct over WebRTC. Use it for high frequency
 *            data (game ticks, cursors) and send deltas, never world state.
 */

/** Identity of a participant: `<userUUID>_<sessionID>`. */
export type Uuid = string;

export interface StateEvent<T = unknown> {
  /** Assigned by the server, monotonic per activity. */
  seq: number;
  /** Participant that sent the event. */
  sender: Uuid;
  /** Server time in milliseconds. */
  ts: number;
  /** Upper case with underscores, e.g. `COUNTER`. */
  type: string;
  data: T;
}

export interface ActionEvent<T = unknown> {
  sender: Uuid;
  type: string;
  data: T;
}

export interface InitPayload {
  instanceId: string;
  plugin: { slug: string; version: string };
  room: { chatUUID: string; subID: number };
  /** This client. */
  self: Uuid;
  /** Everyone in the voice room, including `self`. */
  participants: Uuid[];
  /** Server time at the moment of the reply, in milliseconds. */
  serverNow: number;
  /**
   * True when the user cannot write: `state.send` and `action.send` reject with
   * `E_FORBIDDEN`. Render a passive view, do not hide the content.
   */
  readOnly: boolean;
  /** Declared in `plugin.json`, reviewed with the code. */
  capabilities: string[];
  /**
   * Language of the host, as a BCP-47 tag (`it-IT`, `en-GB`, ...).
   *
   * The plugin lists the languages it has in `plugin.json` (`locales`) and
   * must fall back to `en` for a tag it does not know: the host never sends a
   * language the plugin did not declare, but a client older than the manifest
   * may still send one it does not have.
   */
  locale: string;
  /**
   * The theme the host is drawn in: the theme type.
   *
   * `system` is already resolved here. A plugin can keep its own palette in
   * CSS and switch on this value with `watchThemeMode`.
   */
  theme?: ThemeMode;
  /**
   * The palette of the host, computed from the theme mode, the selected
   * palette and the surface treatment of the app.
   *
   * This is the default way to color a plugin. The array is positional: the
   * order is `THEME_COLOR_NAMES` (`background`, `surface`, `surfaceHover`,
   * `field`, `line`, `outline`, `text`, `muted`, `primary`, `onPrimary`,
   * `primarySoft`, `danger`, `success`, `warning`, `info`). `watchTheme` writes
   * it to the `--nv-*` CSS custom properties and keeps it up to date.
   *
   * The app always sends it. In development the dev host sends
   * `DEFAULT_THEME_COLORS`, so a plugin that uses it needs no special case.
   */
  themeColors?: ThemeColors;
  state: {
    /** Last sequence number assigned to the activity. */
    seq: number;
    /** The oldest events may have been trimmed: rebuild from what is here. */
    truncated: boolean;
    /** Oldest first. */
    events: StateEvent[];
  };
}

export type ErrorCode =
  | 'E_FORBIDDEN'
  | 'E_TOO_LARGE'
  | 'E_RATE_LIMITED'
  | 'E_NOT_IN_ROOM'
  | 'E_CAPABILITY'
  | 'E_NETWORK'
  | 'E_UNSUPPORTED'
  | 'E_INTERNAL';

export interface SdkError extends Error {
  code: ErrorCode;
}

export interface AppSDK {
  /** Resolves once, with the snapshot. Calling it again returns the same payload. */
  init(): Promise<InitPayload>;

  /** Participants of the voice room change while the activity runs. */
  onParticipants(callback: (participants: Uuid[]) => void): () => void;

  /** The activity was stopped, or the host went away. */
  onEnded(callback: (reason: 'stopped' | 'host-gone') => void): () => void;

  /**
   * The user changed the theme, the palette or the surface treatment.
   *
   * The host pushes the new palette while the activity runs, so a plugin does
   * not have to be reloaded to follow the app. `watchTheme` and
   * `watchThemeMode` subscribe here; use this directly only for something they
   * cannot express, and fall back to `init().theme` when the app is older than
   * the plugin and the member is missing.
   */
  onTheme(callback: (theme: ThemeState) => void): () => void;

  state: {
    /**
     * Appends a mutation. Resolves with the `seq` and `ts` the server assigned.
     * The event comes back to the sender too: reconcile, do not double apply.
     */
    send<T = unknown>(type: string, data?: T): Promise<{ seq: number; ts: number }>;
    /** Events of a type, replayed from `init()` onward. */
    on<T = unknown>(type: string, callback: (event: StateEvent<T>) => void): () => void;
  };

  action: {
    send<T = unknown>(type: string, data?: T): Promise<void>;
    on<T = unknown>(callback: (event: ActionEvent<T>) => void): () => void;
  };

  stream: {
    /** At most 8 KiB per packet. The plugin throttles: the host does not. */
    send(bytes: Uint8Array): void;
    on(callback: (sender: Uuid, bytes: Uint8Array) => void): () => void;
  };

  users: {
    /** Public profile from the local store of the app. Never an email, never a token. */
    get(uuid: Uuid): Promise<{ uuid: Uuid; name: string; surname: string | null } | null>;
  };

  ui: {
    requestFullscreen(): void;
    exitFullscreen(): void;
    close(): void;
  };

  /**
   * The video of a file link, played by the app itself.
   *
   * A plugin lives in a WebView: it can embed a page, not decode a video. So a
   * direct `https://…/video.mp4` is handed to the app, which plays it with the
   * same native player the chat uses and renders it above the sandbox of this
   * activity. Only `http(s)` urls: a path of the device is never opened.
   */
  player: {
    /** Resolves once the player accepted the url; it starts paused. */
    open(url: string): Promise<void>;
    /** Closes the player of this activity, if one is open. */
    close(): Promise<void>;
    /** The user closed the player from the chrome of the app. */
    onClosed(callback: () => void): () => void;
    /**
     * A play, pause or seek made with the chrome of the app's player.
     *
     * The host does not write the room: it reports what the user did, and the
     * plugin decides whether to publish it, and on which channel.
     */
    onIntent(callback: (playing: boolean, position: number) => void): () => void;
    /**
     * Follows the room: play, pause, and the position to be at.
     */
    sync(playing: boolean, position: number): Promise<void>;
  };

  storage: {
    /** Namespaced per `<slug>:<instanceId>`, capped at 32 KiB per key. */
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };

  /**
   * Temporary S3 files of the activity
   *
   * The bytes never cross Redis: `upload` reserves the file on your quota and
   * returns the direct S3 `uploadURL`, the plugin PUTs there, then `confirm`
   * makes it downloadable. `STATE` carries only `{fileUUID,name,size,mimeType}`.
   * Files die with the activity (stop / room empty)
   */
  file: {
    upload(name: string, mimeType: string, size: number): Promise<{ fileUUID: string; uploadURL: string; expiresAt: string }>;
    confirm(fileUUID: string): Promise<void>;
    download(fileUUID: string): Promise<{ downloadURL: string; name: string; size: number; mimeType: string }>;
    remove(fileUUID: string): Promise<void>;
  };

  log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void;
}

export type {
  ThemeColorName,
  ThemeColors,
  ThemeMode,
  ThemeState,
} from './theme';
export {
  DEFAULT_THEME_COLORS,
  THEME_COLOR_NAMES,
  THEME_COLOR_VARIABLES,
  applyThemeColors,
  defaultThemeMode,
  isThemeColors,
  normalizeTheme,
  setThemeMode,
  themeFromPayload,
  watchTheme,
  watchThemeMode,
} from './theme';

declare global {
  interface Window {
    AppSDK?: AppSDK;
  }
}

/**
 * The SDK of the running activity.
 *
 * Throws outside the app and outside the development host, which is what we
 * want: a plugin opened in a plain browser is not a supported environment.
 */
export function getAppSDK(): AppSDK {
  const sdk = window.AppSDK;

  if (!sdk) {
    throw new Error(
      'window.AppSDK is missing: run inside the Novyse app, or install the development host (see @novyse/app-sdk/dev).',
    );
  }

  return sdk;
}
