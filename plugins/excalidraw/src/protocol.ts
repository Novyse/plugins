import type { StateEvent } from '@novyse/app-sdk';

/**
 * The event protocol of the board.
 *
 * The `STATE` channel of the SDK is an append-only, server-ordered log that is
 * replayed in full to whoever joins later, so the log *is* the whiteboard: four
 * types are enough to rebuild it, and every one of them is a complete, validated
 * statement, never a delta of a delta.
 *
 * - `UPSERT`    the elements that changed (add and update together: Excalidraw
 *               versions its elements, so there is no need to distinguish);
 * - `DELETE`    the ids that are gone;
 * - `APP_STATE` the part of the canvas that belongs to the room rather than to
 *               the screen: the background and the grid;
 * - `COMPACT`   a full snapshot, split in chunks, that replaces everything
 *               before it. Without it a trimmed log (`truncated: true`) would
 *               rebuild a mutilated board.
 */

export const UPSERT = 'UPSERT';
export const DELETE = 'DELETE';
export const APP_STATE = 'APP_STATE';
export const COMPACT = 'COMPACT';

export const EVENT_TYPES = [UPSERT, DELETE, APP_STATE, COMPACT] as const;

/**
 * The part of an Excalidraw element the protocol relies on.
 *
 * Deliberately structural instead of importing Excalidraw's own type: the
 * protocol must not break when their element type gains fields, and everything
 * coming from the log is validated against this before it reaches the canvas.
 */
export interface BoardElement {
  id: string;
  type: string;
  x: number;
  y: number;
  /** Bumped by Excalidraw on every local mutation: the tie-breaker. */
  version: number;
  /** Random per mutation, used when two clients edited the same version. */
  versionNonce: number;
  [key: string]: unknown;
}

export function isBoardElement(value: unknown): value is BoardElement {
  if (!value || typeof value !== 'object') return false;

  const element = value as Record<string, unknown>;

  return (
    typeof element.id === 'string' &&
    element.id.length > 0 &&
    typeof element.type === 'string' &&
    typeof element.x === 'number' &&
    typeof element.y === 'number' &&
    typeof element.version === 'number' &&
    typeof element.versionNonce === 'number'
  );
}

/**
 * What of the canvas the room shares.
 *
 * Deliberately short. Zoom, scroll, selection, the tool in hand and the color
 * of the next stroke are how one person is looking at the board, not what the
 * board is: syncing them would make the room fight over one cursor. The
 * background and the grid are the page everyone draws on.
 */
export interface BoardAppState {
  viewBackgroundColor: string;
  gridSize: number | null;
}

export const DEFAULT_APP_STATE: BoardAppState = {
  viewBackgroundColor: '#ffffff',
  gridSize: null,
};

/** Fields a `APP_STATE` payload may carry. */
export const APP_STATE_FIELDS = ['viewBackgroundColor', 'gridSize'] as const;

/** A color Excalidraw can put on a canvas: hex, a name, `transparent`. */
function isColor(value: string): boolean {
  return value.length > 0 && value.length <= 32 && !/[\s;{}<>"']/.test(value);
}

/**
 * Reads an `APP_STATE` payload, keeping only the fields that are valid.
 *
 * Everything arriving on the log is shared with the other clients of the room:
 * a color that is not a color would reach the canvas, and a grid width of
 * `NaN` would freeze it.
 */
export function parseAppState(value: unknown): Partial<BoardAppState> | null {
  if (!value || typeof value !== 'object') return null;

  const raw = value as Record<string, unknown>;
  const patch: Partial<BoardAppState> = {};

  if (typeof raw.viewBackgroundColor === 'string' && isColor(raw.viewBackgroundColor)) {
    patch.viewBackgroundColor = raw.viewBackgroundColor;
  }

  if (raw.gridSize === null) {
    patch.gridSize = null;
  } else if (
    typeof raw.gridSize === 'number' &&
    Number.isFinite(raw.gridSize) &&
    raw.gridSize > 0 &&
    raw.gridSize <= 1_000
  ) {
    patch.gridSize = raw.gridSize;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function mergeAppState(
  current: BoardAppState,
  patch: Partial<BoardAppState>,
): BoardAppState {
  return {
    viewBackgroundColor: patch.viewBackgroundColor ?? current.viewBackgroundColor,
    gridSize: patch.gridSize === undefined ? current.gridSize : patch.gridSize,
  };
}

export function sameAppState(left: BoardAppState, right: BoardAppState): boolean {
  return (
    left.viewBackgroundColor === right.viewBackgroundColor &&
    left.gridSize === right.gridSize
  );
}

/** Fields Excalidraw rewrites locally: never a difference worth publishing. */
const VOLATILE = ['version', 'versionNonce', 'updated'];

/**
 * What the element *is*, ignoring its bookkeeping.
 *
 * This is the comparison used to decide whether the local scene moved away from
 * what the room knows. Comparing versions instead would re-publish every element
 * the moment Excalidraw bumps a nonce on a programmatic update, and the log would
 * fill with echoes.
 */
export function signature(element: BoardElement): string {
  const copy: Record<string, unknown> = { ...element };
  for (const key of VOLATILE) delete copy[key];

  return JSON.stringify(copy);
}

/** Last writer wins, with Excalidraw's own rule. */
export function prefer(next: BoardElement, current: BoardElement | undefined): boolean {
  if (!current) return true;
  if (next.version !== current.version) return next.version > current.version;

  return next.versionNonce > current.versionNonce;
}

export type ParsedEvent =
  | { type: typeof UPSERT; elements: BoardElement[] }
  | { type: typeof DELETE; ids: string[] }
  | { type: typeof APP_STATE; appState: Partial<BoardAppState> }
  | {
      type: typeof COMPACT;
      cid: string;
      chunk: number;
      total: number;
      elements: BoardElement[];
      appState: Partial<BoardAppState> | null;
    };

/** One event from the wire, or `null` if it is not a board event we can trust. */
export function parseEvent(event: StateEvent): ParsedEvent | null {
  const data = event.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== 'object') return null;

  if (event.type === UPSERT) {
    const elements = Array.isArray(data.elements) ? data.elements.filter(isBoardElement) : [];
    return elements.length > 0 ? { type: UPSERT, elements } : null;
  }

  if (event.type === DELETE) {
    const ids = Array.isArray(data.ids)
      ? data.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    return ids.length > 0 ? { type: DELETE, ids } : null;
  }

  if (event.type === APP_STATE) {
    const appState = parseAppState(data);
    return appState ? { type: APP_STATE, appState } : null;
  }

  if (event.type === COMPACT) {
    const cid = typeof data.cid === 'string' ? data.cid : '';
    const chunk = typeof data.chunk === 'number' ? data.chunk : -1;
    const total = typeof data.total === 'number' ? data.total : 0;
    const elements = Array.isArray(data.elements) ? data.elements.filter(isBoardElement) : [];

    if (!cid || chunk < 0 || total < 1 || chunk >= total) return null;

    return {
      type: COMPACT,
      cid,
      chunk,
      total,
      elements,
      appState: parseAppState(data.appState),
    };
  }

  return null;
}

/**
 * How the log changed the board.
 *
 * `upsert` and `remove` are what the canvas has to be told about; `reset` means
 * a completed `COMPACT` replaced the whole board; `appstate` means the page
 * itself changed.
 */
export type Change =
  | { kind: 'upsert'; elements: BoardElement[] }
  | { kind: 'remove'; ids: string[] }
  | { kind: 'reset'; elements: BoardElement[]; appState?: BoardAppState }
  | { kind: 'appstate'; appState: BoardAppState };

export interface Folder {
  /** Folds one event. Returns what changed, or `null`. */
  apply(event: StateEvent): Change | null;
  /** The board as folded so far, oldest element first. */
  elements(): BoardElement[];
  /** The shared page: background and grid. */
  appState(): BoardAppState;
  /** Records a local write, so it is not published again on the next diff. */
  setState(patch: Partial<BoardAppState>): void;
  /** Number of complete `COMPACT` events seen. */
  compacts(): number;
}

/**
 * A log folder: the late joiner path, and the live path, with the same code.
 *
 * A partial `COMPACT` is buffered and ignored until all its chunks arrive, so a
 * snapshot interrupted by a client that left can never truncate the board.
 */
export function createFolder(): Folder {
  const elements = new Map<string, BoardElement>();
  const partial = new Map<string, { total: number; parts: Map<number, BoardElement[]> }>();
  let appState: BoardAppState = { ...DEFAULT_APP_STATE };
  let compactCount = 0;

  const applyAppState = (patch: Partial<BoardAppState> | null): Change | null => {
    if (!patch) return null;

    const next = mergeAppState(appState, patch);
    if (sameAppState(next, appState)) return null;

    appState = next;

    return { kind: 'appstate', appState };
  };

  return {
    apply(event) {
      const parsed = parseEvent(event);
      if (!parsed) return null;

      if (parsed.type === UPSERT) {
        const applied: BoardElement[] = [];

        for (const element of parsed.elements) {
          const current = elements.get(element.id);
          if (!prefer(element, current)) continue;

          elements.set(element.id, element);
          applied.push(element);
        }

        return applied.length > 0 ? { kind: 'upsert', elements: applied } : null;
      }

      if (parsed.type === DELETE) {
        const removed = parsed.ids.filter((id) => elements.delete(id));
        return removed.length > 0 ? { kind: 'remove', ids: removed } : null;
      }

      if (parsed.type === APP_STATE) return applyAppState(parsed.appState);

      const entry = partial.get(parsed.cid) ?? { total: parsed.total, parts: new Map() };
      if (entry.total !== parsed.total) return null;

      entry.parts.set(parsed.chunk, parsed.elements);
      partial.set(parsed.cid, entry);

      if (entry.parts.size !== entry.total) return null;

      elements.clear();
      for (let index = 0; index < entry.total; index += 1) {
        for (const element of entry.parts.get(index) ?? []) elements.set(element.id, element);
      }

      partial.delete(parsed.cid);
      compactCount += 1;

      // The snapshot carries the page as well: it is the state of the room at
      // that point, and a late joiner must not have to find an `APP_STATE` that
      // the trimming may have removed.
      const page = applyAppState(parsed.appState);

      return {
        kind: 'reset',
        elements: [...elements.values()],
        ...(page ? { appState } : {}),
      };
    },

    elements() {
      return [...elements.values()];
    },

    appState() {
      return appState;
    },

    setState(patch) {
      appState = mergeAppState(appState, patch);
    },

    compacts() {
      return compactCount;
    },
  };
}

/**
 * Ceiling of one `state.send`, in UTF-8 bytes.
 *
 * The host measures `data` in bytes and refuses anything over 16 KiB with
 * `E_TOO_LARGE`, so the budget stays below it with room for the wrapper
 * (`{"elements":[…]}`, plus `cid`/`chunk`/`total`/`appState` on a `COMPACT`):
 * a chunk that fits here is never refused after it was measured.
 */
const MAX_CHUNK_BYTES = 12 * 1024;

/** Bytes of JSON around the payload: the wrapper, and the commas between entries. */
const ENVELOPE_BYTES = 256;

const encoder = new TextEncoder();

/** Size of one value on the wire, in bytes: the unit the host counts in. */
function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * Splits elements into groups small enough for one `STATE` event.
 *
 * The server refuses oversized writes (`E_TOO_LARGE`), and a snapshot of a board
 * with a few thousand elements would be far over that: chunking keeps every
 * event inside the limit without guessing the exact one.
 *
 * An element that is on its own over the budget still gets a chunk of its own:
 * it cannot be split without changing the drawing, and the caller has to hear
 * about the refusal instead of losing the rest of the board with it.
 */
export function chunkElements(
  elements: BoardElement[],
  maxBytes = MAX_CHUNK_BYTES,
): BoardElement[][] {
  const chunks: BoardElement[][] = [];
  let current: BoardElement[] = [];
  let size = ENVELOPE_BYTES;

  for (const element of elements) {
    const bytes = byteLength(element) + 1;

    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = ENVELOPE_BYTES;
    }

    current.push(element);
    size += bytes;
  }

  if (current.length > 0 || chunks.length === 0) chunks.push(current);

  return chunks;
}

/** The same budget, for an event that carries ids instead of elements. */
export function chunkIds(ids: string[], maxBytes = MAX_CHUNK_BYTES): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = ENVELOPE_BYTES;

  for (const id of ids) {
    const bytes = byteLength(id) + 1;

    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = ENVELOPE_BYTES;
    }

    current.push(id);
    size += bytes;
  }

  if (current.length > 0 || chunks.length === 0) chunks.push(current);

  return chunks;
}
