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
 * - the caps (16/4/8 KiB) are not enforced.
 */
import type { ActionEvent, AppSDK, InitPayload, StateEvent, Uuid } from './index';

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
}

type Message =
  | { kind: 'state'; sender: Uuid; event: StateEvent }
  | { kind: 'action'; sender: Uuid; type: string; data: unknown }
  | { kind: 'stream'; sender: Uuid; bytes: Uint8Array }
  | { kind: 'hello'; sender: Uuid }
  | { kind: 'sync'; sender: Uuid; events: StateEvent[] };

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

  let events: StateEvent[] = [];
  let initPromise: Promise<InitPayload> | null = null;
  const storagePrefix = `novyse-dev:${options.slug}:`;

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
