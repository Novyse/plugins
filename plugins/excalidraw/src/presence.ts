import type { AppSDK, Uuid } from '@novyse/app-sdk';

import type { BoardElement } from './protocol';

/**
 * The live layer: the stroke a participant is drawing right now, and the
 * cursors.
 *
 * Nothing here is a fact: a preview is an impression of a hand that is still
 * moving, it is never replayed to a late joiner, and it is dropped the moment
 * the element lands in the `STATE` log.
 *
 * Only a freehand stroke is previewed, and it is drawn by this overlay instead
 * of being put on the canvas: a stroke of the room is one line, one color and
 * one width, and letting the receiver render the whole element was a second
 * renderer that never matched the sender (it always came out black, with the
 * wrong width). Moving and resizing are not previewed at all: the element shows
 * up when the log carries it.
 */

/** Reliable "the gesture is over": the element is about to be in the log. */
export const PREVIEW_END = 'PREVIEW_END';

/** Screen width of a stroke of the room, in pixels. */
const STROKE_WIDTH = 3;

/** The color of a stroke of the room, by theme. */
const STROKE_COLORS = { dark: '#ffffff', light: '#000000' } as const;

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
 * Characters of the stroke per packet.
 *
 * A `stream` packet is 8 KiB and the payload is JSON, so the budget stays
 * well below it: a freedraw stroke of a few hundred points is a few packets,
 * and a lost one is simply replaced by the next preview of the same stroke.
 */
const PREVIEW_CHUNK_CHARS = 3_000;

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

type Point = [number, number];

/** What of a freedraw element travels: where it starts and its own points. */
interface Stroke {
  x: number;
  y: number;
  points: Point[];
}

type Packet =
  | { k: 'p'; x: number; y: number }
  | {
      k: 's';
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

interface Preview {
  stroke: Stroke;
  touchedAt: number;
}

export interface PresenceOptions {
  /** The element that contains the Excalidraw canvas. */
  container: HTMLElement;
  sdk: AppSDK;
  self: Uuid;
  /** The theme of the board: it decides the color of the strokes. */
  theme: 'dark' | 'light';
}

export class Presence {
  private readonly options: PresenceOptions;
  private readonly cursors = new Map<string, Cursor>();
  private readonly names = new Map<string, string>();
  private readonly requested = new Set<string>();
  /** Buffers of the previews still arriving, by `<sender>:<element>`. */
  private readonly incoming = new Map<string, Incoming>();
  /** Strokes of the room being drawn, by element id. */
  private readonly previews = new Map<string, Preview>();
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

        if (this.previews.delete(data.id)) this.dirty = true;
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
    this.previews.clear();
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.dirty = true;
  }

  /** Streams one stroke of the local canvas to the room, if it is one. */
  publish(element: BoardElement): void {
    const stroke = strokeOf(element);
    if (!stroke) return;

    const json = JSON.stringify(stroke);
    const seq = (this.seq += 1);
    const total = Math.max(1, Math.ceil(json.length / PREVIEW_CHUNK_CHARS));

    for (let chunk = 0; chunk < total; chunk += 1) {
      this.send({
        k: 's',
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

  /**
   * The element landed in the log: its preview is over.
   */
  drop(ids: Iterable<string>): void {
    let changed = false;

    for (const id of ids) {
      if (this.previews.delete(id)) changed = true;
    }

    if (changed) this.dirty = true;
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

    // A newer preview of the same stroke starts over: the older one is a
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

    const stroke = parseStroke(this.join(entry));
    if (!stroke) return;

    this.previews.set(packet.id, { stroke, touchedAt: now });
    this.ensureName(sender);
    this.dirty = true;
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

    for (const [id, preview] of this.previews) {
      if (now - preview.touchedAt <= PREVIEW_TTL_MS) continue;
      this.previews.delete(id);
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
    const strokeColor = STROKE_COLORS[this.options.theme];

    for (const { stroke } of this.previews.values()) {
      let path = '';

      stroke.points.forEach((point, index) => {
        const px = x(stroke.x + point[0]).toFixed(1);
        const py = y(stroke.y + point[1]).toFixed(1);

        path += `${index === 0 ? 'M' : 'L'}${px} ${py}`;
      });

      if (!path) continue;

      parts.push(
        `<path d="${path}" fill="none" stroke="${strokeColor}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`,
      );
    }

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

    if (packet.k !== 's') return null;
    if (typeof packet.id !== 'string' || packet.id.length === 0) return null;
    if (!isFiniteNumber(packet.seq)) return null;
    if (!isFiniteNumber(packet.chunk) || !isFiniteNumber(packet.total)) return null;
    if (packet.chunk < 0 || packet.total < 1 || packet.chunk >= packet.total) return null;
    if (typeof packet.data !== 'string') return null;

    return {
      k: 's',
      id: packet.id,
      seq: packet.seq,
      chunk: packet.chunk,
      total: packet.total,
      data: packet.data,
    };
  }
}

/** The stroke a freedraw element is, `null` for anything else. */
function strokeOf(element: BoardElement): Stroke | null {
  if (element.type !== 'freedraw') return null;
  if (!isFiniteNumber(element.x) || !isFiniteNumber(element.y)) return null;

  const raw = Array.isArray(element.points) ? element.points : [];
  const points: Point[] = [];

  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2) continue;
    if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) continue;

    points.push([point[0], point[1]]);
  }

  return points.length > 0 ? { x: element.x, y: element.y, points } : null;
}

function parseStroke(json: string): Stroke | null {
  let value: unknown;

  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }

  if (!value || typeof value !== 'object') return null;

  const raw = value as Record<string, unknown>;

  if (!isFiniteNumber(raw.x) || !isFiniteNumber(raw.y)) return null;
  if (!Array.isArray(raw.points) || raw.points.length === 0) return null;

  const points: Point[] = [];

  for (const point of raw.points) {
    if (!Array.isArray(point) || point.length < 2) return null;
    if (!isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) return null;

    points.push([point[0], point[1]]);
  }

  return { x: raw.x, y: raw.y, points };
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
