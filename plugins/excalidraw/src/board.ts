import type { StateEvent } from '@novyse/app-sdk';

import {
  createFolder,
  signature,
  type BoardAppState,
  type BoardElement,
  type Change,
  type Folder,
} from './protocol';

/**
 * The board: the folded log, plus what the room already knows about it.
 *
 * `sigs` is the baseline used to answer "what did the local user change?". It
 * holds the signature of every element the room has been told about: their own
 * writes as soon as they are published, and the remote ones as soon as they are
 * applied. Anything in the scene that differs from this baseline is a local
 * change waiting to be sent, and anything the baseline has and the scene does not
 * is a deletion. Because the comparison ignores version bookkeeping, an element
 * re-applied by Excalidraw produces no difference, so remote events cannot echo
 * back into the log.
 *
 * The same idea covers the page: `folder.appState()` is the background and the
 * grid the room knows, and `diffAppState` compares it with the one on screen.
 */
export interface Diff {
  upsert: BoardElement[];
  remove: string[];
}

export class Board {
  private readonly folder: Folder;
  private readonly sigs = new Map<string, string>();
  private readonly files = new Set<string>();
  private readonly previews = new Map<string, BoardElement>();

  constructor(folder: Folder = createFolder()) {
    this.folder = folder;
  }

  /**
   * Takes over a folder that already folded the log: the late joiner path.
   *
   * The folder is reused, not copied: it is the board, and it has to keep
   * receiving the live events that arrive after `init()`.
   */
  static from(folder: Folder): Board {
    const board = new Board(folder);
    for (const element of folder.elements()) board.remember(element);

    return board;
  }

  get size(): number {
    return this.folder.elements().length;
  }

  has(id: string): boolean {
    return this.sigs.has(id);
  }

  hasFile(id: string): boolean {
    return this.files.has(id);
  }

  /** The elements being drawn by the room, by id. */
  previewsOf(): ReadonlyMap<string, BoardElement> {
    return this.previews;
  }

  /** Shows one element the room is drawing. */
  setPreview(element: BoardElement): void {
    this.previews.set(element.id, element);
  }

  /** The gesture ended, or the log carried the element: the preview is gone. */
  clearPreview(id: string): boolean {
    return this.previews.delete(id);
  }

  clearPreviews(): void {
    this.previews.clear();
  }

  markFileSent(id: string): void {
    this.files.add(id);
  }

  elements(): BoardElement[] {
    return this.folder.elements();
  }

  appState(): BoardAppState {
    return this.folder.appState();
  }

  /** Folds a live event. `null` when it changed nothing the canvas shows. */
  apply(event: StateEvent): Change | null {
    const change = this.folder.apply(event);
    if (!change) return null;

    if (change.kind === 'upsert') {
      for (const element of change.elements) {
        this.remember(element);
        // The log is the truth now: the preview has done its job.
        this.previews.delete(element.id);
      }
    } else if (change.kind === 'remove') {
      for (const id of change.ids) {
        this.sigs.delete(id);
        this.previews.delete(id);
      }
    } else if (change.kind === 'reset') {
      this.sigs.clear();
      this.previews.clear();
      for (const element of change.elements) this.remember(element);
    }

    return change;
  }

  /** What the local scene changed, compared with what the room knows. */
  diff(scene: readonly BoardElement[]): Diff {
    const upsert: BoardElement[] = [];
    const remove: string[] = [];
    const seen = new Set<string>();

    for (const element of scene) {
      seen.add(element.id);

      // A preview is the room's element, not a local edit: publishing it
      // would echo the gesture back as a fact before it ended.
      if (this.previews.has(element.id)) continue;

      const known = this.sigs.get(element.id);
      if (known === signature(element)) continue;

      upsert.push(element);
    }

    for (const id of this.sigs.keys()) {
      if (seen.has(id) || this.previews.has(id)) continue;
      remove.push(id);
    }

    return { upsert, remove };
  }

  /** The page the local canvas has and the room does not, field by field. */
  diffAppState(local: BoardAppState): Partial<BoardAppState> | null {
    const known = this.folder.appState();
    const patch: Partial<BoardAppState> = {};

    if (local.viewBackgroundColor !== known.viewBackgroundColor) {
      patch.viewBackgroundColor = local.viewBackgroundColor;
    }

    if (local.gridSize !== known.gridSize) {
      patch.gridSize = local.gridSize;
    }

    return Object.keys(patch).length > 0 ? patch : null;
  }

  /**
   * The write left: its elements are part of the board, not just of the
   * baseline.
   *
   * Adding them to the folder too closes the gap between the publication and
   * the echo: a redraw in that gap used to drop an element that `sigs` already
   * considered known, and the following diff published the deletion.
   */
  markSent(elements: BoardElement[]): void {
    this.folder.setElements(elements);
    for (const element of elements) this.remember(element);
  }

  markRemoved(ids: string[]): void {
    for (const id of ids) this.sigs.delete(id);
  }

  /** The new page left: the next diff compares against it. */
  markAppStateSent(patch: Partial<BoardAppState>): void {
    this.folder.setState(patch);
  }

  /**
   * Re-reads the signatures from the scene after a programmatic update.
   *
   * Excalidraw may normalize an element it is given; refreshing only the
   * signature (never the element, never its version) keeps the echo out of the
   * log without touching the ordering rule.
   */
  sync(scene: readonly BoardElement[]): void {
    for (const element of scene) {
      if (!this.sigs.has(element.id)) continue;
      if (this.previews.has(element.id)) continue;
      this.sigs.set(element.id, signature(element));
    }
  }

  private remember(element: BoardElement): void {
    this.sigs.set(element.id, signature(element));
  }
}
