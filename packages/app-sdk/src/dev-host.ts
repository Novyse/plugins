/**
 * A fake host for local development.
 *
 * It implements the same `window.AppSDK` contract as the app, over a
 * `BroadcastChannel`: open the plugin in two tabs and they see each other as
 * two participants of the same voice room. That is enough to develop a plugin
 * without the app, without a backend and without LiveKit.
 *
 * What it emulates:
 *
 * - `state`: an event log per tab, merged between tabs, replayed to a tab that
 *   opens later exactly like a late joiner (that is the point of the harness);
 * - `action`: broadcast, never replayed;
 * - `stream`: broadcast as structured-cloned bytes;
 * - `users.get`: fake profiles;
 * - `storage`: `localStorage`, namespaced by plugin.
 *
 * What it does not emulate, by design:
 *
 * - the server is the authority: here `seq` is `max(known) + 1` and `ts` is the
 *   local clock, so concurrent senders can interleave differently than on the
 *   real server. Do not build logic on the ordering between two senders;
 * - the caps (16/4/8 KiB) are not enforced;
 * - S3 is memory: `file` keeps the bytes of this tab (and of the tabs that
 *   confirmed while this one was open) instead of a bucket, so a file uploaded
 *   before a tab opens is not there for it, reload the uploader instead.
 */
import type { ActionEvent, AppSDK, InitPayload, StateEvent, Uuid } from './index';
import {
  DEFAULT_THEME_COLORS,
  normalizeTheme,
  type ThemeColors,
  type ThemeMode,
  type ThemeState,
} from './theme';

export interface DevHostOptions {
  slug: string;
  version?: string;
  chatUUID?: string;
  subID?: number;
  /** Identity of this tab. Random by default. */
  self?: Uuid;
  /** The other participants, simulated. */
  participants?: Uuid[];
  /**
   * Language of the fake host, a BCP-47 tag. Defaults to `?lang=` of the page
   * and then to the language of the browser.
   */
  locale?: string;
  /**
   * Theme of the fake host. Defaults to `?theme=` of the page and then to the
   * preference of the browser.
   */
  theme?: ThemeMode;
  /**
   * Palette of the fake host, in the order of `THEME_COLOR_NAMES`.
   * Defaults to `?colors=` (comma separated) and then to
   * `DEFAULT_THEME_COLORS` for the active mode.
   */
  themeColors?: ThemeColors;
}

type Message =
  | { kind: 'state'; sender: Uuid; event: StateEvent }
  | { kind: 'action'; sender: Uuid; type: string; data: unknown }
  | { kind: 'stream'; sender: Uuid; bytes: Uint8Array }
  | { kind: 'hello'; sender: Uuid }
  | { kind: 'sync'; sender: Uuid; events: StateEvent[] }
  | {
      kind: 'file';
      sender: Uuid;
      fileUUID: string;
      name: string;
      mimeType: string;
      bytes: Uint8Array;
    };

/** Installs the fake host, unless a real one is already there. */
export function installDevHost(options: DevHostOptions): void {
  if (window.AppSDK) return;

  const channel = new BroadcastChannel(`novyse-activity-dev:${options.slug}`);
  const self: Uuid = options.self ?? `dev-${randomSuffix()}`;
  const participants = new Set<Uuid>([
    self,
    ...(options.participants ?? ['dev-alice', 'dev-bob']),
  ]);

  const stateListeners = new Map<string, Set<(event: StateEvent) => void>>();
  const actionListeners = new Set<(event: ActionEvent) => void>();
  const streamListeners = new Set<(sender: Uuid, bytes: Uint8Array) => void>();
  const participantsListeners = new Set<(participants: Uuid[]) => void>();
  const endedListeners = new Set<(reason: 'stopped' | 'host-gone') => void>();
  const themeListeners = new Set<(theme: ThemeState) => void>();

  let themeState = devTheme(options);

  // No palette of the app exists here: when the user switches the system
  // theme, the fake host answers exactly like the app does, so `onTheme` and
  // the `--nv-*` variables can be checked in `npm run dev`.
  const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  colorScheme?.addEventListener?.('change', () => {
    themeState = devTheme(options);
    for (const listener of themeListeners) listener(themeState);
  });

  let events: StateEvent[] = [];
  let initPromise: Promise<InitPayload> | null = null;
  const storagePrefix = `novyse-dev:${options.slug}:`;

  const devFiles = new Map<
    string,
    { name: string; mimeType: string; bytes: Uint8Array; confirmed: boolean }
  >();
  const devPending = new Map<string, { name: string; mimeType: string }>();

  (window as unknown as { __novyseDevFilePut?: unknown }).__novyseDevFilePut = async (
    uploadURL: string,
    bytes: Uint8Array,
    mimeType: string,
  ) => {
    const fileUUID = uploadURL.replace(/^devfile:\/\//, '');
    const pending = devPending.get(fileUUID);
    if (!pending) throw new Error('Unknown upload');

    devPending.delete(fileUUID);
    devFiles.set(fileUUID, {
      name: pending.name,
      mimeType: mimeType || pending.mimeType,
      bytes,
      confirmed: false,
    });
  };

  const merge = (incoming: StateEvent[]) => {
    const known = new Set(events.map((event) => `${event.sender}:${event.seq}`));
    const fresh = incoming.filter((event) => !known.has(`${event.sender}:${event.seq}`));

    if (fresh.length === 0) return;

    events = [...events, ...fresh].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  };

  channel.onmessage = (message: MessageEvent<Message>) => {
    const payload = message.data;

    switch (payload.kind) {
      case 'hello':
        participants.add(payload.sender);
        notifyParticipants();
        channel.postMessage({ kind: 'sync', sender: self, events } satisfies Message);
        break;

      case 'sync':
        merge(payload.events);
        break;

      case 'state':
        merge([payload.event]);
        dispatchState(payload.event);
        break;

      case 'action':
        for (const listener of actionListeners) {
          listener({ sender: payload.sender, type: payload.type, data: payload.data });
        }
        break;

      case 'stream':
        for (const listener of streamListeners) {
          listener(payload.sender, payload.bytes);
        }
        break;

      case 'file':
        if (payload.sender !== self) {
          devFiles.set(payload.fileUUID, {
            name: payload.name,
            mimeType: payload.mimeType,
            bytes: payload.bytes,
            confirmed: true,
          });
        }
        break;
    }
  };

  function notifyParticipants() {
    const list = [...participants];

    for (const listener of participantsListeners) {
      listener(list);
    }
  }

  function dispatchState(event: StateEvent) {
    for (const listener of stateListeners.get(event.type) ?? []) {
      listener(event);
    }

    for (const listener of stateListeners.get('*') ?? []) {
      listener(event);
    }
  }

  const sdk: AppSDK = {
    init() {
      if (initPromise) return initPromise;

      // A newcomer announces itself and waits a moment for the history of the
      // tabs that are already open: this is the late joiner path.
      channel.postMessage({ kind: 'hello', sender: self } satisfies Message);

      initPromise = new Promise<InitPayload>((resolve) => {
        setTimeout(() => {
          resolve({
            instanceId: `dev-${options.slug}`,
            plugin: { slug: options.slug, version: options.version ?? '0.0.0' },
            room: { chatUUID: options.chatUUID ?? 'dev-chat', subID: options.subID ?? 0 },
            self,
            participants: [...participants],
            serverNow: Date.now(),
            readOnly: false,
            capabilities: ['stream', 'fullscreen', 'network'],
            locale: options.locale ?? devLocale(),
            theme: themeState.theme,
            themeColors: themeState.themeColors,
            state: {
              seq: events.reduce((max, event) => Math.max(max, event.seq), 0),
              truncated: false,
              events: [...events],
            },
          });
        }, 150);
      });

      return initPromise;
    },

    onParticipants(callback) {
      participantsListeners.add(callback);
      return () => participantsListeners.delete(callback);
    },

    onEnded(callback) {
      endedListeners.add(callback);
      return () => endedListeners.delete(callback);
    },

    onTheme(callback) {
      themeListeners.add(callback);
      return () => themeListeners.delete(callback);
    },

    state: {
      async send(type, data) {
        const event: StateEvent = {
          seq: events.reduce((max, candidate) => Math.max(max, candidate.seq), 0) + 1,
          sender: self,
          ts: Date.now(),
          type,
          data,
        };

        merge([event]);
        channel.postMessage({ kind: 'state', sender: self, event } satisfies Message);
        dispatchState(event);

        return { seq: event.seq, ts: event.ts };
      },

      on(type, callback) {
        const listeners = stateListeners.get(type) ?? new Set();
        listeners.add(callback as (event: StateEvent) => void);
        stateListeners.set(type, listeners);

        return () => listeners.delete(callback as (event: StateEvent) => void);
      },
    },

    action: {
      async send(type, data) {
        channel.postMessage({ kind: 'action', sender: self, type, data } satisfies Message);

        for (const listener of actionListeners) {
          listener({ sender: self, type, data });
        }
      },

      on(callback) {
        actionListeners.add(callback as (event: ActionEvent) => void);
        return () => actionListeners.delete(callback as (event: ActionEvent) => void);
      },
    },

    stream: {
      send(bytes) {
        channel.postMessage({ kind: 'stream', sender: self, bytes } satisfies Message);
      },

      on(callback) {
        streamListeners.add(callback);
        return () => streamListeners.delete(callback);
      },
    },

    users: {
      async get(uuid) {
        if (!uuid) return null;

        return {
          uuid,
          name: uuid.replace(/^dev-/, '').replace(/_[0-9]+$/, ''),
          surname: null,
        };
      },
    },

    ui: {
      requestFullscreen() {
        void document.documentElement.requestFullscreen?.();
      },
      exitFullscreen() {
        void document.exitFullscreen?.();
      },
      close() {
        for (const listener of endedListeners) {
          listener('stopped');
        }
      },
    },

    player: {
      async open() {
        // A browser tab has no native backend: the real host plays the file
        // with media_kit, the harness cannot. Failing loudly is better than a
        // fake player that behaves differently from the app.
        throw Object.assign(
          new Error('The native player runs inside the Novyse app only'),
          { code: 'E_UNSUPPORTED' as const },
        );
      },
      async close() {},
      onClosed() {
        return () => {};
      },
      onIntent() {
        return () => {};
      },
      async sync() {
        // A browser tab has no native player to keep in step.
      },
    },

    storage: {
      async get(key) {
        const raw = localStorage.getItem(storagePrefix + key);
        return raw === null ? null : JSON.parse(raw);
      },
      async set(key, value) {
        localStorage.setItem(storagePrefix + key, JSON.stringify(value));
      },
      async delete(key) {
        localStorage.removeItem(storagePrefix + key);
      },
    },

    file: {
      async upload(name, mimeType, size) {
        if (!name || !mimeType || !Number.isFinite(size) || size < 1) {
          throw Object.assign(new Error('No file metadata'), { code: 'E_INTERNAL' as const });
        }

        const fileUUID = `dev-${randomSuffix()}${randomSuffix()}`;
        devPending.set(fileUUID, { name, mimeType });

        return {
          fileUUID,
          uploadURL: `devfile://${fileUUID}`,
          expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        };
      },

      async confirm(fileUUID) {
        const record = devFiles.get(fileUUID);
        if (!record) {
          throw Object.assign(new Error('Nothing was uploaded'), { code: 'E_INTERNAL' as const });
        }

        record.confirmed = true;
        channel.postMessage({
          kind: 'file',
          sender: self,
          fileUUID,
          name: record.name,
          mimeType: record.mimeType,
          bytes: record.bytes,
        } satisfies Message);
      },

      async download(fileUUID) {
        const record = devFiles.get(fileUUID);
        if (!record || !record.confirmed) {
          throw Object.assign(new Error('Gone'), { code: 'E_NOT_FOUND' as const });
        }

        const downloadURL = URL.createObjectURL(
          new Blob([record.bytes as unknown as BlobPart], { type: record.mimeType }),
        );

        return {
          downloadURL,
          name: record.name,
          size: record.bytes.length,
          mimeType: record.mimeType,
        };
      },

      async remove(fileUUID) {
        devFiles.delete(fileUUID);
      },
    },

    log(level, ...args) {
      // eslint-disable-next-line no-console
      (console[level] ?? console.log)(`[${options.slug}]`, ...args);
    },
  };

  window.AppSDK = sdk;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** `?lang=it-IT` wins, then the browser, then English. */
function devLocale(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('lang');
  if (fromQuery) return fromQuery;

  return navigator.language || 'en';
}

/** `?theme=light` wins, then the option, then the browser preference. */
function devTheme(options: DevHostOptions): ThemeState {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get('theme');
  const mode: ThemeMode =
    requested === 'light' || requested === 'dark'
      ? requested
      : options.theme ??
        (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const colors = options.themeColors ?? parseThemeColors(query.get('colors'));

  return colors
    ? normalizeTheme(mode, colors)
    : { theme: mode, themeColors: DEFAULT_THEME_COLORS[mode] };
}

/** `?colors=%23f5f9ff,%23f1f6ff,…`, in the order of `THEME_COLOR_NAMES`. */
function parseThemeColors(raw: string | null): ThemeColors | null {
  if (!raw) return null;

  const colors = raw
    .split(',')
    .map((color) => color.trim())
    .filter(Boolean);

  return colors.length > 0 ? colors : null;
}
