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

  storage: {
    /** Namespaced per `<slug>:<instanceId>`, capped at 32 KiB per key. */
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };

  log(level: 'debug' | 'info' | 'warn' | 'error', ...args: unknown[]): void;
}

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
