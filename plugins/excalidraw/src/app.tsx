import { useCallback, useEffect, useRef, useState } from 'react';

import { Excalidraw } from '@excalidraw/excalidraw';
import { getAppSDK, type InitPayload, type StateEvent } from '@novyse/app-sdk';

import { Board } from './board';
import { messagesFor, normalizeLocale, type Locale, type Messages } from './i18n';
import { Presence, type Viewport } from './presence';
import { shrinkImage } from './image';
import {
  APP_STATE,
  COMPACT,
  DEFAULT_APP_STATE,
  DELETE,
  EVENT_TYPES,
  FILE,
  SYNC_REQUEST,
  UPSERT,
  chunkElements,
  chunkIds,
  createFolder,
  type BoardAppState,
  type BoardElement,
  type BoardFile,
} from './protocol';

/** How many events before the owner of the board republishes a snapshot. */
const COMPACT_EVERY = 120;
/** Debounce of the local diff: a drag is many changes, one write. */
const FLUSH_MS = 150;

/**
 * Interval of the live preview.
 */
const PREVIEW_MS = 50;

/** Ceiling of one image on the wire, in bytes, once downscaled. */
const MAX_FILE_BYTES = 300 * 1024;

/** Base64 characters per `FILE` event: ~6 KiB, well inside one `STATE`. */
const FILE_CHUNK_CHARS = 8_000;

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
  getFiles(): Record<string, BoardFile>;
  addFiles(files: BoardFile[]): void;
}

interface ContainerState {
  scrollX: number;
  scrollY: number;
  zoom: { value: number };
  viewBackgroundColor?: string;
  gridSize?: number | null;
  selectedElementsAreBeingDragged?: boolean;
  newElement?: unknown;
  editingElement?: unknown;
  resizingElement?: unknown;
  multiElement?: unknown;
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

  const queuedRef = useRef<StateEvent[]>([]);
  const refusedRef = useRef(new Set<string>());
  const sinceCompactRef = useRef(0);
  const forceCompactRef = useRef(false);
  const compactingRef = useRef(false);
  const flushingRef = useRef(false);
  const againRef = useRef(false);
  const flushTimerRef = useRef(0);
  const renderFrameRef = useRef(0);
  const renderRetryRef = useRef(0);

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
   * Puts the folded board and the local gesture on the canvas.
   *
   * Everything the board knows keeps the object it already has, so a remote
   * update cannot cancel a drag in progress. The elements only this screen has
   * — the stroke under the mouse — are appended as they are: replacing them
   * would delete the line being drawn. The gestures of the room are not here at
   * all: `presence` draws them, as strokes, in its own overlay.
   */
  const render = useCallback(() => {
    const api = apiRef.current;
    const board = boardRef.current;
    if (!api || !board) return;

    const scene = api.getSceneElements();
    const elements: BoardElement[] = [];
    const known = new Set<string>();

    for (const element of board.elements()) {
      known.add(element.id);
      elements.push(element);
    }

    for (const element of scene) {
      if (known.has(element.id)) continue;
      known.add(element.id);
      elements.push(element);
    }

    api.updateScene({ elements });

    // Excalidraw may normalize what it was given: refresh the comparison
    // baseline from the scene so the normalization is not mistaken for a local
    // edit and published back to the room.
    board.sync(api.getSceneElements());
  }, []);

  const renderRef = useRef(render);
  renderRef.current = render;

  /**
   * True while the local hand is busy.
   *
   * Replacing the elements under a drag or a resize cancels it: Excalidraw
   * rebuilds the element it was mutating, the handles disappear mid-gesture,
   * and the element snaps back to its last published size.
   */
  const interacting = useCallback(() => {
    const state = apiRef.current?.getAppState();
    if (!state) return false;    return Boolean(
      state.selectedElementsAreBeingDragged ||
        state.newElement ||
        state.editingElement ||
        state.resizingElement ||
        state.multiElement,
    );
  }, []);

  const scheduleRenderRef = useRef<() => void>(() => {});

  const scheduleRender = useCallback(() => {
    // The room's change waits for the hand: a redraw now would cancel the
    // gesture instead of landing after it.
    if (interacting()) {
      if (!renderRetryRef.current) {
        renderRetryRef.current = window.setTimeout(() => {
          renderRetryRef.current = 0;
          scheduleRenderRef.current();
        }, 200);
      }

      return;
    }

    if (renderFrameRef.current) return;

    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = 0;
      renderRef.current();
    });
  }, [interacting]);

  scheduleRenderRef.current = scheduleRender;

  // ----------------------------------------------------------------- protocol

  const compactRef = useRef<() => Promise<void>>(async () => {});
  const canCompactRef = useRef<() => boolean>(() => true);
  const maybeCompactRef = useRef<() => void>(() => {});
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const handleRef = useRef<(event: StateEvent) => void>(() => {});
  const answerSyncRef = useRef<() => void>(() => {});
  const requestSnapshotRef = useRef<() => void>(() => {});

  /**
   * Publishes what the local user changed since the last known state.
   *
   * Additions, updates, deletions and the background come from one comparison
   * against the baseline, so a paste of fifty elements, a resize, an eraser
   * stroke and a new background all cost a predictable number of events instead
   * of one per element.
   */
  /**
   * Publishes the images the room does not have yet.
   *
   * An image element only carries a `fileId`; the bytes live in Excalidraw's
   * file store. Without them a late joiner draws an empty rectangle, so the file
   * travels too — downscaled and chunked, because one `STATE` event is 16 KiB
   * and a screenshot is not.
   */
  const pushFiles = useCallback(
    async (all: boolean) => {
      const api = apiRef.current;
      const board = boardRef.current;
      if (!api || !board) return;

      const referenced = new Set<string>();

      for (const element of board.elements()) {
        if (element.type !== 'image') continue;
        if (typeof element.fileId === 'string') referenced.add(element.fileId);
      }

      if (referenced.size === 0) return;

      const files = api.getFiles();

      for (const id of referenced) {
        if (!all && board.hasFile(id)) continue;

        const file = files[id];
        if (!file || typeof file.dataURL !== 'string' || file.dataURL.length === 0) continue;

        const prepared = await shrinkImage(file.dataURL, MAX_FILE_BYTES);
        if (!prepared) {
          setError(messagesRef.current.imageTooBig);
          board.markFileSent(id);
          continue;
        }

        const encoded = prepared.dataURL.slice(prepared.dataURL.indexOf(',') + 1);
        const total = Math.max(1, Math.ceil(encoded.length / FILE_CHUNK_CHARS));
        const created = typeof file.created === 'number' && file.created > 0 ? file.created : Date.now();

        for (let chunk = 0; chunk < total; chunk += 1) {
          await sdk.state.send(FILE, {
            id,
            mimeType: prepared.mimeType,
            created,
            chunk,
            total,
            data: encoded.slice(chunk * FILE_CHUNK_CHARS, (chunk + 1) * FILE_CHUNK_CHARS),
          });
        }

        board.markFileSent(id);
      }
    },
    [sdk],
  );

  const pushFilesRef = useRef(pushFiles);
  pushFilesRef.current = pushFiles;

  const flush = useCallback(async () => {
    // A half-resized element must not be published: the room would see the
    // gesture stop halfway and the next echo would fight the pointer.
    if (readOnlyRef.current || interacting()) {
      if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
      flushTimerRef.current = window.setTimeout(() => {
        flushTimerRef.current = 0;
        void flushRef.current();
      }, 300);

      return;
    }

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
      // Before the elements that reference them: a receiver draws the image the
      // moment its element lands.
      await pushFilesRef.current(false);

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

      // The room has these elements now: the preview of this gesture is done.
      presenceRef.current?.end([
        ...sendable.map((element) => element.id),
        ...remove,
      ]);
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

  /**
   * Publishes the elements the local hand is still moving.
   *
   * Same comparison as [flush] — the scene against what the room knows — but
   * over `STREAM`, and without marking anything as sent: the log is written
   * once, when the gesture ends.
   */
  const publishPreviews = useCallback(() => {
    const api = apiRef.current;
    const board = boardRef.current;
    const presence = presenceRef.current;

    if (!api || !board || !presence || readOnlyRef.current) return;

    const { upsert } = board.diff(api.getSceneElements());
    for (const element of upsert) presence.publish(element);
  }, []);

  const previewTimerRef = useRef(0);

  /** At most one preview per [PREVIEW_MS]. */
  const schedulePreview = useCallback(() => {
    if (previewTimerRef.current) return;

    previewTimerRef.current = window.setTimeout(() => {
      previewTimerRef.current = 0;
      publishPreviews();
    }, PREVIEW_MS);
  }, [publishPreviews]);

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
    // An empty board is not a snapshot of anything: publishing it would wipe
    // the room instead of catching up the client that asked.
    if (!board || board.size === 0 || compactingRef.current || readOnlyRef.current) return;

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
    if (compactingRef.current || interacting()) return;
    if (!canCompactRef.current()) return;

    forceCompactRef.current = false;
    void compactRef.current();
  };

  /** Any client holding a board answers a late joiner, whatever the order. */
  answerSyncRef.current = () => {
    const board = boardRef.current;
    if (readOnlyRef.current || !board || board.size === 0) return;

    void (async () => {
      try {
        await pushFilesRef.current(true);
        await compactRef.current();
      } catch (cause) {
        setError(describe(cause, messagesRef.current));
      }
    })();
  };

  /** The periodic snapshot, still decided by the sorted participant list. */
  requestSnapshotRef.current = () => {
    if (!canCompactRef.current()) return;

    forceCompactRef.current = true;
    maybeCompactRef.current();
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

    if (change?.kind === 'upsert' || change?.kind === 'reset') {
      presenceRef.current?.drop(change.elements.map((element) => element.id));
    } else if (change?.kind === 'remove') {
      presenceRef.current?.drop(change.ids);
    }

    if (change?.kind === 'appstate') {
      applyAppStateRef.current();
    } else if (change?.kind === 'file') {
      // The bytes are what make the image visible: install them, then redraw.
      // The copy that comes back to its own author is the re-encoded one that
      // travelled, and the screen that added the image already has the file.
      if (event.sender !== initRef.current?.self) {
        apiRef.current?.addFiles([change.file]);
        // The room has these bytes now: they are not re-sent on the next diff.
        board.markFileSent(change.file.id);
      }
      scheduleRender();
    } else {
      // A snapshot carries the page too: after a reset the theme and the grid
      // of the room must be applied to the canvas, not only its elements.
      if (change?.kind === 'reset' && change.appState) applyAppStateRef.current();
      if (change || event.type === COMPACT) scheduleRender();
    }

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
      const grew = participants.length > participantsRef.current.length;
      participantsRef.current = participants;

      // Someone joined: waiting for the periodic snapshot would leave them in
      // front of an empty board.
      if (grew) requestSnapshotRef.current();
    });

    const offSyncRequests = sdk.action.on((event) => {
      if (event.type !== SYNC_REQUEST) return;
      answerSyncRef.current();
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

        // The log may have been trimmed while this client was away, and a
        // trimmed log is a mutilated board: asking the room for a snapshot is
        // one tiny action, the answer is everything.
        if (payload.participants.length > 1 && !payload.readOnly) {
          void sdk.action.send(SYNC_REQUEST, {}).catch(() => undefined);
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
      offSyncRequests();
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
      // The stroke of the room is drawn by the overlay, with one width and the
      // color of the theme: the element itself is never previewed.
      theme: init.theme === 'dark' ? 'dark' : 'light',
    });

    presence.setViewport(viewportRef.current);
    presence.attach();
    presenceRef.current = presence;

    return () => {
      presence.detach();
      presenceRef.current = null;
    };
  }, [init, sdk]);

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
          theme={init.theme === 'dark' ? 'dark' : 'light'}
          langCode={locale === 'it' ? 'it-IT' : 'en'}
          viewModeEnabled={passive}
          excalidrawAPI={(api) => {
            apiRef.current = api as unknown as BoardApi;

            const files = boardRef.current?.imageFiles() ?? [];
            if (files.length > 0) apiRef.current.addFiles(files);

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

            presenceRef.current?.setViewport(viewportRef.current);

            // A gesture in progress travels as a preview, so the room sees it
            // move; the write to the log waits for the hand to stop.
            if (interacting()) schedulePreview();
            else scheduleFlush();
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
