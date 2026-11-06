import { useCallback, useEffect, useRef, useState } from 'react';

import { Excalidraw } from '@excalidraw/excalidraw';
import { getAppSDK, type InitPayload, type StateEvent } from '@novyse/app-sdk';

import { Board } from './board';
import { messagesFor, normalizeLocale, type Locale, type Messages } from './i18n';
import { Presence, type LocalStyle, type Viewport } from './presence';
import {
  APP_STATE,
  COMPACT,
  DEFAULT_APP_STATE,
  DELETE,
  EVENT_TYPES,
  UPSERT,
  chunkElements,
  chunkIds,
  createFolder,
  type BoardAppState,
  type BoardElement,
} from './protocol';

/** How many events before the owner of the board republishes a snapshot. */
const COMPACT_EVERY = 120;
/** Debounce of the local diff: a drag is many changes, one write. */
const FLUSH_MS = 150;

/**
 * The slice of Excalidraw's imperative API this board uses.
 *
 * Typed here instead of imported from the package on purpose: the protocol must
 * survive an Excalidraw upgrade, and these members are all the surface the board
 * actually touches. The cast happens once, where the API is handed over.
 */
interface BoardApi {
  getSceneElements(): BoardElement[];
  getAppState(): ContainerState;
  updateScene(scene: {
    elements?: BoardElement[];
    appState?: Partial<BoardAppState>;
  }): void;
}

interface ContainerState {
  activeTool?: { type?: string };
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  currentItemStrokeColor: string;
  currentItemStrokeWidth: number;
  currentItemOpacity: number;
  viewBackgroundColor?: string;
  gridSize?: number | null;
}

/** The page on screen, as the protocol sees it. */
function appStateOf(state: ContainerState): BoardAppState {
  return {
    viewBackgroundColor: state.viewBackgroundColor ?? DEFAULT_APP_STATE.viewBackgroundColor,
    gridSize: state.gridSize ?? null,
  };
}

export function App() {
  const sdk = getAppSDK();

  const [init, setInit] = useState<InitPayload | null>(null);
  const [locale, setLocale] = useState<Locale>(() => normalizeLocale(navigator.language));
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const t = messagesFor(locale);
  const messagesRef = useRef<Messages>(t);
  messagesRef.current = t;

  const apiRef = useRef<BoardApi | null>(null);
  const boardRef = useRef<Board | null>(null);
  const presenceRef = useRef<Presence | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const initRef = useRef<InitPayload | null>(null);

  const readyRef = useRef(false);
  const lastSeqRef = useRef(0);
  const readOnlyRef = useRef(false);
  const participantsRef = useRef<string[]>([]);
  const viewportRef = useRef<Viewport>({ scrollX: 0, scrollY: 0, zoom: 1 });
  const styleRef = useRef<LocalStyle>({ strokeColor: '#1e1e1e', strokeWidth: 2, opacity: 100 });

  const queuedRef = useRef<StateEvent[]>([]);
  const refusedRef = useRef(new Set<string>());
  const sinceCompactRef = useRef(0);
  const forceCompactRef = useRef(false);
  const compactingRef = useRef(false);
  const flushingRef = useRef(false);
  const againRef = useRef(false);
  const flushTimerRef = useRef(0);
  const renderFrameRef = useRef(0);

  // ------------------------------------------------------------------ canvas

  /**
   * Puts the page the room shares on the canvas.
   *
   * Only the background and the grid: zoom, scroll and the tool in hand belong
   * to the person looking, and applying them from the log would move the board
   * under everyone's mouse.
   */
  const applyAppState = useCallback(() => {
    const api = apiRef.current;
    const board = boardRef.current;
    if (!api || !board) return;

    api.updateScene({ appState: board.appState() });
  }, []);

  const applyAppStateRef = useRef(applyAppState);
  applyAppStateRef.current = applyAppState;

  /**
   * Puts the folded board on the canvas.
   *
   * The elements the local user is drawing are not in the board yet, and they
   * must survive the update: they are kept as they are, appended to the folded
   * ones, or applying a remote event mid-stroke would delete the line under the
   * mouse.
   */
  const render = useCallback(() => {
    const api = apiRef.current;
    const board = boardRef.current;
    if (!api || !board) return;

    const scene = api.getSceneElements();
    const localOnly = scene.filter((element) => !board.has(element.id));

    api.updateScene({ elements: [...board.elements(), ...localOnly] });

    // Excalidraw may normalize what it was given: refresh the comparison
    // baseline from the scene so the normalization is not mistaken for a local
    // edit and published back to the room.
    board.sync(api.getSceneElements());
  }, []);

  const renderRef = useRef(render);
  renderRef.current = render;

  const scheduleRender = useCallback(() => {
    // A redraw in the middle of a local stroke is what makes it jump.
    if (presenceRef.current?.isDrawing()) return;
    if (renderFrameRef.current) return;

    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = 0;
      renderRef.current();
    });
  }, []);

  // ----------------------------------------------------------------- protocol

  const compactRef = useRef<() => Promise<void>>(async () => {});
  const canCompactRef = useRef<() => boolean>(() => true);
  const maybeCompactRef = useRef<() => void>(() => {});
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const handleRef = useRef<(event: StateEvent) => void>(() => {});

  /**
   * Publishes what the local user changed since the last known state.
   *
   * Additions, updates, deletions and the background come from one comparison
   * against the baseline, so a paste of fifty elements, a resize, an eraser
   * stroke and a new background all cost a predictable number of events instead
   * of one per element.
   */
  const flush = useCallback(async () => {
    if (readOnlyRef.current || presenceRef.current?.isDrawing()) return;

    if (flushingRef.current) {
      againRef.current = true;
      return;
    }

    const api = apiRef.current;
    const board = boardRef.current;
    if (!api || !board) return;

    const { upsert, remove } = board.diff(api.getSceneElements());
    const page = board.diffAppState(appStateOf(api.getAppState()));

    // An element the host already refused as too big is not re-measured and
    // re-sent on every diff: it stays on this screen and the banner says so.
    const sendable = upsert.filter((element) => !refusedRef.current.has(element.id));

    if (sendable.length === 0 && remove.length === 0 && !page) return;

    flushingRef.current = true;
    setError(null);

    try {
      for (const chunk of chunkElements(sendable)) {
        if (chunk.length === 0) continue;

        try {
          await sdk.state.send(UPSERT, { elements: chunk });
          board.markSent(chunk);
        } catch (cause) {
          // One element over the ceiling of a single `STATE` event must not
          // freeze the rest of the board: the others still reach the room.
          for (const element of chunk) refusedRef.current.add(element.id);
          setError(describe(cause, messagesRef.current));
        }
      }

      for (const chunk of chunkIds(remove)) {
        if (chunk.length === 0) continue;

        await sdk.state.send(DELETE, { ids: chunk });
        board.markRemoved(chunk);
      }

      if (page) {
        await sdk.state.send(APP_STATE, page);
        board.markAppStateSent(page);
      }
    } catch (cause) {
      setError(describe(cause, messagesRef.current));
    } finally {
      flushingRef.current = false;
    }

    if (againRef.current) {
      againRef.current = false;
      void flushRef.current();
    }
  }, [sdk]);

  flushRef.current = flush;

  const scheduleFlush = useCallback((delay = FLUSH_MS) => {
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);

    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = 0;
      void flushRef.current();
    }, delay);
  }, []);

  /**
   * Republishes the whole board as a snapshot.
   *
   * The log is not infinite: the server trims it, and `init().truncated` says so.
   * A snapshot is what makes the board rebuildable from any point after it, and
   * it also keeps the log short for the next late joiner. The page travels with
   * it, so a snapshot is enough to rebuild the whole room.
   */
  const compact = useCallback(async () => {
    const board = boardRef.current;
    if (!board || compactingRef.current || readOnlyRef.current) return;

    compactingRef.current = true;

    try {
      const chunks = chunkElements(board.elements());
      const cid = `${initRef.current?.self ?? 'board'}:${Date.now().toString(36)}`;

      for (let index = 0; index < chunks.length; index += 1) {
        await sdk.state.send(COMPACT, {
          cid,
          chunk: index,
          total: chunks.length,
          elements: chunks[index],
          appState: board.appState(),
        });
      }

      sinceCompactRef.current = 0;
    } catch (cause) {
      setError(describe(cause, messagesRef.current));
    } finally {
      compactingRef.current = false;
    }
  }, [sdk]);

  compactRef.current = compact;

  // Only one client compacts, or the log would fill with identical snapshots.
  // The choice is deterministic and needs no election: the first participant.
  canCompactRef.current = () => {
    const self = initRef.current?.self;
    if (!self) return false;

    const participants = [...participantsRef.current].sort();
    if (participants.length === 0) return true;

    return participants[0] === self;
  };

  maybeCompactRef.current = () => {
    if (!readyRef.current || readOnlyRef.current) return;

    const forced = forceCompactRef.current;
    if (!forced && sinceCompactRef.current < COMPACT_EVERY) return;
    if (compactingRef.current || presenceRef.current?.isDrawing()) return;
    if (!canCompactRef.current()) return;

    forceCompactRef.current = false;
    void compactRef.current();
  };

  handleRef.current = (event: StateEvent) => {
    if (!readyRef.current) {
      queuedRef.current.push(event);
      return;
    }

    if (event.seq <= lastSeqRef.current) return;
    lastSeqRef.current = event.seq;

    const board = boardRef.current;
    if (!board) return;

    // A snapshot from anyone is a fresh baseline for the log we have.
    if (event.type === COMPACT) sinceCompactRef.current = 0;

    const change = board.apply(event);

    if (change?.kind === 'appstate') applyAppStateRef.current();
    else if (change || event.type === COMPACT) scheduleRender();

    sinceCompactRef.current += 1;
    maybeCompactRef.current();
  };

  // ------------------------------------------------------------------- boot

  useEffect(() => {
    let alive = true;

    const folder = createFolder();

    const offs = EVENT_TYPES.map((type) =>
      sdk.state.on(type, (event) => handleRef.current(event)),
    );

    const offParticipants = sdk.onParticipants((participants) => {
      participantsRef.current = participants;
    });

    const offEnded = sdk.onEnded(() => setEnded(true));

    sdk
      .init()
      .then((payload) => {
        if (!alive) return;

        for (const event of payload.state.events) folder.apply(event);

        const board = Board.from(folder);

        boardRef.current = board;
        initRef.current = payload;
        lastSeqRef.current = payload.state.seq;
        participantsRef.current = payload.participants;
        readOnlyRef.current = payload.readOnly;
        readyRef.current = true;

        setInit(payload);
        setLocale(normalizeLocale(payload.locale));

        // A trimmed log only hurts when it holds no snapshot: otherwise the
        // beginning of the board is simply gone and a snapshot has to be made.
        if (payload.state.truncated && folder.compacts() === 0) {
          forceCompactRef.current = true;
        }

        const queued = queuedRef.current;
        queuedRef.current = [];
        for (const event of queued) handleRef.current(event);

        renderRef.current();
        applyAppStateRef.current();
        maybeCompactRef.current();
      })
      .catch((cause: unknown) => {
        if (alive) setError(describe(cause, messagesRef.current));
      });

    return () => {
      alive = false;
      for (const off of offs) off();
      offParticipants();
      offEnded();
    };
  }, [sdk]);

  // ---------------------------------------------------------------- presence

  useEffect(() => {
    const container = canvasRef.current;
    if (!init || !container) return;

    const presence = new Presence({
      container,
      sdk,
      self: init.self,
      getActiveTool: () => apiRef.current?.getAppState().activeTool?.type ?? 'selection',
      onCommit: () => {
        scheduleRender();
        scheduleFlush(0);
      },
    });

    presence.setViewport(viewportRef.current);
    presence.setStyle(styleRef.current);
    presence.attach();
    presenceRef.current = presence;

    return () => {
      presence.detach();
      presenceRef.current = null;
    };
  }, [init, sdk, scheduleFlush, scheduleRender]);

  // -------------------------------------------------------------------- view

  if (!init) {
    return (
      <main className="board board--loading">
        <p>{error ?? t.opening}</p>
      </main>
    );
  }

  const passive = init.readOnly || ended;

  return (
    <main className="board">
      <div ref={canvasRef} className="board__canvas">
        <Excalidraw
          theme="light"
          langCode={locale === 'it' ? 'it-IT' : 'en'}
          viewModeEnabled={passive}
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as BoardApi;
            renderRef.current();
            applyAppStateRef.current();
          }}
          onChange={(_scene, appState) => {
            const state = appState as unknown as ContainerState;

            viewportRef.current = {
              scrollX: state.scrollX,
              scrollY: state.scrollY,
              zoom: state.zoom.value,
            };

            styleRef.current = {
              strokeColor: state.currentItemStrokeColor,
              strokeWidth: state.currentItemStrokeWidth,
              opacity: state.currentItemOpacity,
            };

            presenceRef.current?.setViewport(viewportRef.current);
            presenceRef.current?.setStyle(styleRef.current);

            scheduleFlush();
          }}
        />
      </div>

      {passive ? <p className="board__banner">{ended ? t.ended : t.readOnly}</p> : null}

      {error ? (
        <p className="board__error" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  );
}

function describe(cause: unknown, t: Messages): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return `${t.error}: ${String((cause as { message: unknown }).message)}`;
  }

  return `${t.error}: ${String(cause)}`;
}
