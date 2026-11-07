import type { AppSDK, Uuid } from '@novyse/app-sdk';

/**
 * The live layer: ghost strokes over `STREAM`, cursors, and the "stroke is over"
 * signal over `ACTION`.
 *
 * Nothing here is replayed to a late joiner, because nothing here is a fact: it
 * is an impression of a hand that is still moving. The stroke becomes real only
 * when it lands in the `STATE` log, and the preview is dropped at that moment.
 *
 * The packets are tiny JSON objects, deliberately not thrifty with bytes: a
 * stroke at 30 Hz with ~60 points per packet is under 2 KiB, well below the 8 KiB
 * of the channel, and a decoder that can be read by a human is worth more than
 * saving half of a packet.
 */

/** Reliable "this stroke is over", sent on the ACTION channel. */
export const STROKE_END = 'STROKE_END';

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
/** 30 Hz: the preview is fluid without flooding the channel. */
const STROKE_INTERVAL_MS = 33;
const CURSOR_TTL_MS = 8_000;
const GHOST_TTL_MS = 20_000;
/** Points per packet: ~1.5 KiB, safely inside the 8 KiB of `stream`. */
const POINTS_PER_PACKET = 64;

const BOX_TOOLS = new Set(['rectangle', 'ellipse', 'diamond', 'frame']);
const PATH_TOOLS = new Set(['freedraw', 'line', 'arrow']);

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface Viewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface LocalStyle {
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
}

type Point = [number, number];

type Packet =
  | {
      k: 's';
      id: string;
      tool: string;
      kind: 'path' | 'box';
      c: string;
      w: number;
      o: number;
      p: Point[];
    }
  | { k: 'e'; id: string }
  | { k: 'p'; x: number; y: number };

interface Ghost {
  sender: Uuid;
  id: string;
  kind: 'path' | 'box';
  tool: string;
  color: string;
  width: number;
  opacity: number;
  points: Point[];
  start: Point;
  touchedAt: number;
}

interface Cursor {
  x: number;
  y: number;
  touchedAt: number;
}

interface Stroke {
  id: string;
  kind: 'path' | 'box';
  tool: string;
  color: string;
  width: number;
  opacity: number;
  points: Point[];
  sent: number;
  lastSentAt: number;
}

export interface PresenceOptions {
  /** The element that contains the Excalidraw canvas. */
  container: HTMLElement;
  sdk: AppSDK;
  self: Uuid;
  /** The tool Excalidraw has selected right now. */
  getActiveTool: () => string;
  /** The local stroke ended: an element is about to be committed. */
  onCommit: () => void;
  /**
   * The color, width and opacity the user has selected right now.
   */
  getStyle?: () => LocalStyle;
}

export class Presence {
  private readonly options: PresenceOptions;
  private readonly ghosts = new Map<string, Ghost>();
  private readonly cursors = new Map<string, Cursor>();
  private readonly names = new Map<string, string>();
  private readonly requested = new Set<string>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
  private style: LocalStyle = { strokeColor: '#1e1e1e', strokeWidth: 2, opacity: 100 };
  private stroke: Stroke | null = null;
  private lastCursor: { x: number; y: number; at: number } | null = null;
  private svg: SVGSVGElement | null = null;
  private frame = 0;
  private dirty = false;
  private pruneAt = 0;
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
    const onDown = (event: PointerEvent) => this.pointerDown(event);
    const onMove = (event: PointerEvent) => this.pointerMove(event);
    const onUp = () => this.pointerUp();

    container.addEventListener('pointerdown', onDown);
    // Capturing on the container: the point we want is the raw one, whatever
    // Excalidraw has already done with the element.
    container.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);

    this.disposers.push(
      () => container.removeEventListener('pointerdown', onDown),
      () => container.removeEventListener('pointermove', onMove),
      () => window.removeEventListener('pointerup', onUp),
      () => window.removeEventListener('pointercancel', onUp),
    );

    this.disposers.push(
      this.options.sdk.stream.on((sender, bytes) => this.receive(sender, bytes)),
    );

    // `action` is reliable and never replayed: it is the right channel for the
    // end of a stroke, which a lossy packet cannot guarantee.
    this.disposers.push(
      this.options.sdk.action.on((event) => {
        if (event.type !== STROKE_END) return;

        const data = event.data as { id?: unknown } | null;
        if (typeof data?.id !== 'string') return;

        if (this.ghosts.delete(`${event.sender}:${data.id}`)) this.dirty = true;
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
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
    this.dirty = true;
  }

  setStyle(style: LocalStyle): void {
    this.style = style;
  }

  isDrawing(): boolean {
    return this.stroke !== null;
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

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    // The toolbar is a button, not a canvas: only a real drawing click starts a
    // ghost, so pressing "rectangle" does not publish a point.
    if (!(event.target instanceof HTMLCanvasElement)) return;

    const tool = this.options.getActiveTool();
    const kind = BOX_TOOLS.has(tool) ? 'box' : PATH_TOOLS.has(tool) ? 'path' : null;
    if (!kind) return;

    const style = this.options.getStyle?.() ?? this.style;
    this.style = style;

    this.stroke = {
      id: crypto.randomUUID(),
      kind,
      tool,
      color: style.strokeColor,
      width: style.strokeWidth,
      opacity: Math.min(100, Math.max(0, style.opacity)) / 100,
      points: [this.toScene(event)],
      sent: 0,
      lastSentAt: 0,
    };
  }

  private pointerMove(event: PointerEvent): void {
    const point = this.toScene(event);
    const stroke = this.stroke;

    if (stroke) {
      // A box needs its origin and its tip, not every pixel of the drag.
      stroke.points =
        stroke.kind === 'box' ? [stroke.points[0], point] : [...stroke.points, point];
      this.pump(stroke, performance.now(), false);
      this.dirty = true;
      return;
    }

    const now = performance.now();
    if (this.lastCursor) {
      if (now - this.lastCursor.at < CURSOR_INTERVAL_MS) return;

      const moved = Math.hypot(point[0] - this.lastCursor.x, point[1] - this.lastCursor.y);
      if (moved < CURSOR_MIN_DISTANCE) return;
    }

    this.lastCursor = { x: point[0], y: point[1], at: now };
    this.send({ k: 'p', x: point[0], y: point[1] });
  }

  private pointerUp(): void {
    const stroke = this.stroke;
    if (!stroke) return;

    this.stroke = null;

    // The tail of the stroke, then the two signals that drop the preview.
    this.pump(stroke, performance.now(), true);
    this.send({ k: 'e', id: stroke.id });
    void this.options.sdk.action.send(STROKE_END, { id: stroke.id }).catch(() => undefined);

    this.dirty = true;
    this.options.onCommit();
  }

  private pump(stroke: Stroke, now: number, final: boolean): void {
    if (stroke.sent >= stroke.points.length) return;
    if (!final && now - stroke.lastSentAt < STROKE_INTERVAL_MS) return;

    const pending = stroke.points.slice(stroke.sent);
    stroke.sent = stroke.points.length;
    stroke.lastSentAt = now;

    for (let index = 0; index < pending.length; index += POINTS_PER_PACKET) {
      this.send({
        k: 's',
        id: stroke.id,
        tool: stroke.tool,
        kind: stroke.kind,
        c: stroke.color,
        w: stroke.width,
        o: stroke.opacity,
        p: pending.slice(index, index + POINTS_PER_PACKET),
      });
    }
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

    if (packet.k === 'e') {
      if (this.ghosts.delete(key)) this.dirty = true;
      return;
    }

    const existing = this.ghosts.get(key);
    const ghost: Ghost = existing ?? {
      sender,
      id: packet.id,
      kind: packet.kind,
      tool: packet.tool,
      color: packet.c,
      width: packet.w,
      opacity: packet.o,
      points: [],
      start: packet.p[0] ?? [0, 0],
      touchedAt: now,
    };

    if (existing) {
      existing.points.push(...packet.p);
      existing.touchedAt = now;
    } else {
      ghost.points.push(...packet.p);
      this.ghosts.set(key, ghost);
    }

    const target = existing ?? ghost;
    if (target.kind === 'box') {
      target.points = [target.start, packet.p[packet.p.length - 1] ?? target.start];
    }

    this.ensureName(sender);
    this.dirty = true;
  }

  private prune(now: number): void {
    let changed = false;

    for (const [key, ghost] of this.ghosts) {
      if (now - ghost.touchedAt <= GHOST_TTL_MS) continue;
      this.ghosts.delete(key);
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

    for (const ghost of this.ghosts.values()) {
      const color = ghost.color || this.colorOf(ghost.sender);
      const width = Math.max(1, ghost.width * zoom);

      if (ghost.kind === 'box') {
        const [startX, startY] = ghost.start;
        const [endX, endY] = ghost.points[ghost.points.length - 1] ?? ghost.start;
        const left = Math.min(startX, endX);
        const top = Math.min(startY, endY);
        const boxWidth = Math.abs(endX - startX) * zoom;
        const boxHeight = Math.abs(endY - startY) * zoom;

        if (ghost.tool === 'ellipse') {
          parts.push(
            `<ellipse cx="${x(left) + boxWidth / 2}" cy="${y(top) + boxHeight / 2}" rx="${boxWidth / 2}" ry="${boxHeight / 2}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${ghost.opacity}"/>`,
          );
        } else {
          parts.push(
            `<rect x="${x(left)}" y="${y(top)}" width="${boxWidth}" height="${boxHeight}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${ghost.opacity}"/>`,
          );
        }

        continue;
      }

      const points = ghost.points
        .map(([pointX, pointY]) => `${x(pointX).toFixed(1)},${y(pointY).toFixed(1)}`)
        .join(' ');

      parts.push(
        `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${ghost.opacity}"/>`,
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

    if (packet.k === 'e') {
      return typeof packet.id === 'string' ? { k: 'e', id: packet.id } : null;
    }

    if (packet.k !== 's') return null;
    if (typeof packet.id !== 'string') return null;
    if (packet.kind !== 'path' && packet.kind !== 'box') return null;
    if (typeof packet.tool !== 'string') return null;
    if (typeof packet.c !== 'string') return null;
    if (!isFiniteNumber(packet.w) || !isFiniteNumber(packet.o)) return null;
    if (!Array.isArray(packet.p)) return null;

    const points: Point[] = [];
    for (const candidate of packet.p) {
      if (!Array.isArray(candidate) || candidate.length < 2) return null;

      const [pointX, pointY] = candidate;
      if (!isFiniteNumber(pointX) || !isFiniteNumber(pointY)) return null;

      points.push([pointX, pointY]);
    }

    if (points.length === 0) return null;

    return {
      k: 's',
      id: packet.id,
      tool: packet.tool,
      kind: packet.kind,
      c: packet.c,
      w: packet.w,
      o: packet.o,
      p: points,
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
