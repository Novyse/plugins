import type { AppSDK, Uuid } from '@novyse/app-sdk';

import { isBoardElement, type BoardElement } from './protocol';

/**
 * The live layer: the elements the room is drawing right now, and the cursors.
 *
 * Nothing here is a fact: a preview is an impression of a hand that is still
 * moving, it is never replayed to a late joiner, and it is dropped the moment
 * the element lands in the `STATE` log.
 *
 * Previews carry the *real* Excalidraw element rather than a redrawing of it.
 * A stroke drawn again in SVG cannot have the style, the width or the roughness
 * of the one under the sender's mouse, and it cannot show a text being typed or
 * an image being resized at all: the receiver puts the element it is given on
 * its canvas, so it sees exactly what the sender sees, for every element type,
 * with no second renderer to keep in sync.
 */

/** Reliable "the gesture is over": the element is about to be in the log. */
export const PREVIEW_END = 'PREVIEW_END';

const PALETTE = [
  '#e03131',
  '#2f9e44',
  '#1971c2',
  '#f08c00',
  '#9c36b5',
  '#0c8599',
  '#c2255c',
  '#5f3dc4',
];

const CURSOR_INTERVAL_MS = 60;
const CURSOR_MIN_DISTANCE = 3;
const CURSOR_TTL_MS = 8_000;
/** A preview that stops arriving belongs to a gesture that stopped. */
const PREVIEW_TTL_MS = 4_000;
/**
 * Characters of the element per packet.
 *
 * A `stream` packet is 8 KiB and the payload is JSON, so the budget stays
 * well below it: a freedraw stroke of a few hundred points is several packets,
 * and a lost one is simply replaced by the next preview of the same element.
 */
const PREVIEW_CHUNK_CHARS = 3_000;

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

type Point = [number, number];

type Packet =
  | { k: 'p'; x: number; y: number }
  | {
      k: 'v';
      id: string;
      seq: number;
      chunk: number;
      total: number;
      data: string;
    };

interface Cursor {
  x: number;
  y: number;
  touchedAt: number;
}

interface Incoming {
  seq: number;
  total: number;
  parts: Map<number, string>;
  touchedAt: number;
}

export interface PresenceOptions {
  /** The element that contains the Excalidraw canvas. */
  container: HTMLElement;
  sdk: AppSDK;
  self: Uuid;
  /** An element of the room is being drawn: put it on the canvas. */
  onPreview(element: BoardElement): void;
  /** The gesture is over: what the log says is the truth from now on. */
  onPreviewEnd(id: string): void;
}

export class Presence {
  private readonly options: PresenceOptions;
  private readonly cursors = new Map<string, Cursor>();
  private readonly names = new Map<string, string>();
  private readonly requested = new Set<string>();
  /** Buffers of the previews still arriving, by `<sender>:<element>`. */
  private readonly incoming = new Map<string, Incoming>();
  /** Previews handed to the canvas, so a silent sender does not freeze one. */
  private readonly shown = new Map<string, number>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
  private lastCursor: { x: number; y: number; at: number } | null = null;
  private svg: SVGSVGElement | null = null;
  private frame = 0;
  private dirty = false;
  private pruneAt = 0;
  private seq = 0;
  private disposers: Array<() => void> = [];

  constructor(options: PresenceOptions) {
    this.options = options;
  }

  attach(): void {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'board__presence');
    this.options.container.appendChild(svg);
    this.svg = svg;

    const container = this.options.container;
    const onMove = (event: PointerEvent) => this.pointerMove(event);

    container.addEventListener('pointermove', onMove);

    this.disposers.push(
      () => container.removeEventListener('pointermove', onMove),
      this.options.sdk.stream.on((sender, bytes) =>
        this.receive(sender, bytes),
      ),
      // `action` is reliable and never replayed: the right channel for "this
      // gesture is over", which a lossy packet cannot guarantee.
      this.options.sdk.action.on((event) => {
        if (event.type !== PREVIEW_END) return;

        const data = event.data as { id?: unknown } | null;
        if (typeof data?.id !== 'string') return;

        this.options.onPreviewEnd(data.id);
        this.shown.delete(data.id);
      }),
    );

    this.loop();
  }

  detach(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;

    for (const dispose of this.disposers) dispose();
    this.disposers = [];

    this.svg?.remove();
    this.svg = null;
    this.incoming.clear();
    this.shown.clear();
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.dirty = true;
  }

  /** Streams one element of the local canvas to the room. */
  publish(element: BoardElement): void {
    const json = JSON.stringify(element);
    const seq = (this.seq += 1);
    const total = Math.max(1, Math.ceil(json.length / PREVIEW_CHUNK_CHARS));

    for (let chunk = 0; chunk < total; chunk += 1) {
      this.send({
        k: 'v',
        id: element.id,
        seq,
        chunk,
        total,
        data: json.slice(
          chunk * PREVIEW_CHUNK_CHARS,
          (chunk + 1) * PREVIEW_CHUNK_CHARS,
        ),
      });
    }
  }

  /** The gesture is over: the log is about to carry these elements. */
  end(ids: Iterable<string>): void {
    for (const id of ids) {
      void this.options.sdk.action
        .send(PREVIEW_END, { id })
        .catch(() => undefined);
    }
  }

  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop);

    const now = performance.now();
    if (now > this.pruneAt) {
      this.pruneAt = now + 1_000;
      this.prune(now);
    }

    if (!this.dirty) return;

    this.dirty = false;
    this.paint();
  };

  private pointerMove(event: PointerEvent): void {
    const point = this.toScene(event);

    const now = performance.now();
    if (this.lastCursor) {
      if (now - this.lastCursor.at < CURSOR_INTERVAL_MS) return;

      const moved = Math.hypot(
        point[0] - this.lastCursor.x,
        point[1] - this.lastCursor.y,
      );
      if (moved < CURSOR_MIN_DISTANCE) return;
    }

    this.lastCursor = { x: point[0], y: point[1], at: now };
    this.send({ k: 'p', x: point[0], y: point[1] });
  }

  private receive(sender: Uuid, bytes: Uint8Array): void {
    if (sender === this.options.self) return;

    const packet = this.decode(bytes);
    if (!packet) return;

    const now = performance.now();

    if (packet.k === 'p') {
      this.cursors.set(sender, { x: packet.x, y: packet.y, touchedAt: now });
      this.ensureName(sender);
      this.dirty = true;
      return;
    }

    const key = `${sender}:${packet.id}`;
    let entry = this.incoming.get(key);

    // A newer preview of the same element starts over: the older one is a
    // state of the gesture nobody is in anymore.
    if (!entry || entry.seq !== packet.seq) {
      entry = {
        seq: packet.seq,
        total: packet.total,
        parts: new Map<number, string>(),
        touchedAt: now,
      };
      this.incoming.set(key, entry);
    }

    entry.touchedAt = now;
    entry.parts.set(packet.chunk, packet.data);

    if (entry.parts.size !== entry.total) return;

    this.incoming.delete(key);

    let decoded: unknown;

    try {
      decoded = JSON.parse(this.join(entry));
    } catch {
      return;
    }

    if (!isBoardElement(decoded)) return;

    this.shown.set(decoded.id, now);
    this.ensureName(sender);
    this.options.onPreview(decoded);
  }

  private join(entry: Incoming): string {
    let encoded = '';
    for (let index = 0; index < entry.total; index += 1) {
      encoded += entry.parts.get(index) ?? '';
    }

    return encoded;
  }

  private prune(now: number): void {
    let changed = false;

    for (const [key, entry] of this.incoming) {
      if (now - entry.touchedAt <= PREVIEW_TTL_MS) continue;
      this.incoming.delete(key);
    }

    for (const [id, touchedAt] of this.shown) {
      if (now - touchedAt <= PREVIEW_TTL_MS) continue;
      this.shown.delete(id);
      this.options.onPreviewEnd(id);
      changed = true;
    }

    for (const [sender, cursor] of this.cursors) {
      if (now - cursor.touchedAt <= CURSOR_TTL_MS) continue;
      this.cursors.delete(sender);
      changed = true;
    }

    if (changed) this.dirty = true;
  }

  private paint(): void {
    const svg = this.svg;
    if (!svg) return;

    const { scrollX, scrollY, zoom } = this.viewport;
    const x = (value: number) => (value + scrollX) * zoom;
    const y = (value: number) => (value + scrollY) * zoom;

    const parts: string[] = [];

    for (const [sender, cursor] of this.cursors) {
      const color = this.colorOf(sender);
      const name = this.names.get(sender) ?? '';

      parts.push(
        `<g transform="translate(${x(cursor.x).toFixed(1)} ${y(cursor.y).toFixed(1)})"><circle r="3.5" fill="${color}"/>${
          name
            ? `<text x="7" y="4" font-size="11" font-family="ui-sans-serif, system-ui, sans-serif" fill="${color}">${escapeXml(name)}</text>`
            : ''
        }</g>`,
      );
    }

    svg.innerHTML = parts.join('');
  }

  private ensureName(uuid: Uuid): void {
    if (this.names.has(uuid) || this.requested.has(uuid)) return;
    this.requested.add(uuid);

    void this.options.sdk.users
      .get(uuid)
      .then((user) => {
        if (!user) return;

        const name = [user.name, user.surname].filter(Boolean).join(' ');
        this.names.set(uuid, name);
        this.dirty = true;
      })
      .catch(() => undefined);
  }

  private toScene(event: PointerEvent): Point {
    const rect = this.options.container.getBoundingClientRect();
    const zoom = this.viewport.zoom || 1;

    return [
      (event.clientX - rect.left) / zoom - this.viewport.scrollX,
      (event.clientY - rect.top) / zoom - this.viewport.scrollY,
    ];
  }

  private colorOf(uuid: Uuid): string {
    let hash = 0;
    for (let index = 0; index < uuid.length; index += 1) {
      hash = (hash * 31 + uuid.charCodeAt(index)) % 1_000_003;
    }

    return PALETTE[hash % PALETTE.length];
  }

  private send(packet: Packet): void {
    try {
      this.options.sdk.stream.send(this.encoder.encode(JSON.stringify(packet)));
    } catch {
      // Lossy by contract: a dropped preview is a preview that never happened.
    }
  }

  private decode(bytes: Uint8Array): Packet | null {
    let value: unknown;

    try {
      value = JSON.parse(this.decoder.decode(bytes));
    } catch {
      return null;
    }

    if (!value || typeof value !== 'object') return null;

    const packet = value as Record<string, unknown>;

    if (packet.k === 'p') {
      return isFiniteNumber(packet.x) && isFiniteNumber(packet.y)
        ? { k: 'p', x: packet.x, y: packet.y }
        : null;
    }

    if (packet.k !== 'v') return null;
    if (typeof packet.id !== 'string' || packet.id.length === 0) return null;
    if (!isFiniteNumber(packet.seq)) return null;
    if (!isFiniteNumber(packet.chunk) || !isFiniteNumber(packet.total)) return null;
    if (packet.chunk < 0 || packet.total < 1 || packet.chunk >= packet.total) return null;
    if (typeof packet.data !== 'string') return null;

    return {
      k: 'v',
      id: packet.id,
      seq: packet.seq,
      chunk: packet.chunk,
      total: packet.total,
      data: packet.data,
    };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => {
    switch (character) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}
