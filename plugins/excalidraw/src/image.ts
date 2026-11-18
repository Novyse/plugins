/**
 * Images, made fit for one `STATE` budget.
 *
 * The log carries the board, and an image element only carries a `fileId`: the
 * bytes are in Excalidraw's file store. Shipping them as they are would mean a
 * photo of 3 MB, which is ~250 events of 12 KB, kept in the log of the room for
 * the whole call. Downscaling first is the difference between a board that syncs
 * and one that floods the server.
 */

/** Longest side of a downscaled image, in pixels. */
const MAX_SIDE = 1600;

/** Bytes the base64 text of [dataURL] stands for. */
function binaryBytes(dataURL: string): number {
  const comma = dataURL.indexOf(',');
  if (comma < 0) return 0;

  return Math.floor(((dataURL.length - comma - 1) * 3) / 4);
}

/** The raw bytes behind a `data:` URL, with the mime type of its header. */
export function dataURLToBytes(dataURL: string): { bytes: Uint8Array; mimeType: string } | null {
  const comma = dataURL.indexOf(',');
  if (comma < 0) return null;

  const header = dataURL.slice(0, comma);
  const mimeType = /^data:([^;,]+)/.exec(header)?.[1] ?? 'application/octet-stream';

  try {
    const binary = atob(dataURL.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

    return { bytes, mimeType };
  } catch {
    return null;
  }
}




/**
 * Applies the image filter Excalidraw asks for, on engines that ignore it.
 */
interface ColorFilter {
  matrix: number[];
  offset: number[];
}

const NEUTRAL: ColorFilter = { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], offset: [0, 0, 0] };

function multiply3(left: number[], right: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += left[row * 3 + k] * right[k * 3 + column];
      out[row * 3 + column] = sum;
    }
  }
  return out;
}

function apply3(matrix: number[], vector: number[]): number[] {
  return [0, 1, 2].map(
    (row) =>
      matrix[row * 3] * vector[0] +
      matrix[row * 3 + 1] * vector[1] +
      matrix[row * 3 + 2] * vector[2],
  );
}

function then(after: ColorFilter, before: ColorFilter): ColorFilter {
  return {
    matrix: multiply3(after.matrix, before.matrix),
    offset: apply3(after.matrix, before.offset).map((value, i) => value + after.offset[i]),
  };
}

function saturationMatrix(amount: number): number[] {
  return [
    0.213 + 0.787 * amount, 0.715 - 0.715 * amount, 0.072 - 0.072 * amount,
    0.213 - 0.213 * amount, 0.715 + 0.285 * amount, 0.072 - 0.072 * amount,
    0.213 - 0.213 * amount, 0.715 - 0.715 * amount, 0.072 + 0.928 * amount,
  ];
}

function filterStep(name: string, value: number, radians: number): ColorFilter | null {
  switch (name) {
    case 'invert':
      return {
        matrix: [1 - 2 * value, 0, 0, 0, 1 - 2 * value, 0, 0, 0, 1 - 2 * value],
        offset: [value * 255, value * 255, value * 255],
      };
    case 'brightness':
      return { matrix: [value, 0, 0, 0, value, 0, 0, 0, value], offset: [0, 0, 0] };
    case 'saturate':
      return { matrix: saturationMatrix(value), offset: [0, 0, 0] };
    case 'hue-rotate': {
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      return {
        matrix: [
          0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
          0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
          0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
        ],
        offset: [0, 0, 0],
      };
    }
    default:
      return null;
  }
}

/** A CSS `filter` value as one color transform, or `null` when unsupported. */
function parseColorFilter(filter: string): ColorFilter | null {
  const pattern = /([a-z-]+)\(([^)]*)\)/gi;
  let combined: ColorFilter = NEUTRAL;
  let found = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(filter)) !== null) {
    const name = match[1].toLowerCase();
    const raw = match[2].trim();
    let value = 0;
    let radians = 0;

    if (name === 'hue-rotate') {
      const parsed = /([-\d.]+)(deg|rad|turn)?/i.exec(raw);
      if (!parsed) return null;
      value = Number(parsed[1]);
      radians =
        parsed[2] === 'rad'
          ? value
          : parsed[2] === 'turn'
            ? value * Math.PI * 2
            : (value * Math.PI) / 180;
    } else {
      const parsed = /([-\d.]+)\s*(%?)/.exec(raw);
      if (!parsed) return null;
      value = Number(parsed[1]) / (parsed[2] === '%' ? 100 : 1);
    }

    const step = filterStep(name, value, radians);
    if (!step) return null;

    combined = then(step, combined);
    found += 1;
  }

  return found > 0 ? combined : null;
}

/** Baked bitmaps, one per image and filter: the render loop reuses them. */
const bakedImages = new WeakMap<object, Map<string, HTMLCanvasElement>>();

/** Largest bitmap worth baking; past this the plain draw is the better deal. */
const MAX_BAKED_PIXELS = 4096 * 4096;

function bakeFilter(
  image: HTMLImageElement,
  filter: string,
  color: ColorFilter,
  drawRaw: (target: CanvasRenderingContext2D, source: CanvasImageSource) => void,
): HTMLCanvasElement | null {
  const cached = bakedImages.get(image)?.get(filter);
  if (cached) return cached;

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width === 0 || height === 0 || width * height > MAX_BAKED_PIXELS) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  drawRaw(context, image);

  let pixels: ImageData;
  try {
    pixels = context.getImageData(0, 0, width, height);
  } catch {
    return null;
  }

  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = color.matrix;
  const [o0, o1, o2] = color.offset;
  const clamp = (value: number) => (value < 0 ? 0 : value > 255 ? 255 : value);
  const data = pixels.data;

  for (let index = 0; index < data.length; index += 4) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];

    data[index] = clamp(m0 * r + m1 * g + m2 * b + o0);
    data[index + 1] = clamp(m3 * r + m4 * g + m5 * b + o1);
    data[index + 2] = clamp(m6 * r + m7 * g + m8 * b + o2);
  }

  context.putImageData(pixels, 0, 0);

  if (!bakedImages.has(image)) bakedImages.set(image, new Map());
  bakedImages.get(image)!.set(filter, canvas);

  return canvas;
}

/** True when this engine applies `ctx.filter` to a `drawImage` at all. */
function honorsCanvasFilter(): boolean {
  try {
    const source = document.createElement('canvas');
    source.width = 1;
    source.height = 1;
    const sourceContext = source.getContext('2d');
    if (!sourceContext) return true;
    sourceContext.fillStyle = '#ff0000';
    sourceContext.fillRect(0, 0, 1, 1);

    const target = document.createElement('canvas');
    target.width = 1;
    target.height = 1;
    const targetContext = target.getContext('2d', { willReadFrequently: true });
    if (!targetContext) return true;

    targetContext.filter = 'invert(1)';
    targetContext.drawImage(source, 0, 0);

    const pixel = targetContext.getImageData(0, 0, 1, 1).data;
    return pixel[0] === 0 && pixel[1] === 255 && pixel[2] === 255;
  } catch {
    return true;
  }
}

let filterFallbackInstalled = false;

/**
 * Compensates images on engines whose `ctx.filter` does nothing.
 *
 * Called once per document. Engines that honour the filter are left untouched:
 * no wrapper, no pixel work, the normal path stays exactly as it is.
 */
export function installImageFilterFallback(): void {
  try {
    if (filterFallbackInstalled || honorsCanvasFilter()) return;
    filterFallbackInstalled = true;

    const prototype = CanvasRenderingContext2D.prototype;
    const original = prototype.drawImage as unknown as (
      this: CanvasRenderingContext2D,
      ...args: unknown[]
    ) => void;

    prototype.drawImage = function patchedDrawImage(
      this: CanvasRenderingContext2D,
      source: CanvasImageSource,
      ...rest: unknown[]
    ): void {
      try {
        const filter = this.filter;

        // Only the theme inversion, only a real image, so the rasters
        // Excalidraw builds from it are drawn once, unfiltered.
        if (
          !filter ||
          filter === 'none' ||
          filter.indexOf('invert') === -1 ||
          !(source instanceof HTMLImageElement)
        ) {
          original.apply(this, [source, ...rest]);
          return;
        }

        const color = parseColorFilter(filter);
        const baked = color
          ? bakeFilter(source, filter, color, (target, image) => {
              original.call(target, image, 0, 0, target.canvas.width, target.canvas.height);
            })
          : null;

        if (!baked) {
          original.apply(this, [source, ...rest]);
          return;
        }

        // The pixels already carry the filter: asking for it again would
        // double it, and on this engine double it into black.
        this.filter = 'none';
        try {
          original.apply(this, [baked, ...rest]);
        } finally {
          this.filter = filter;
        }
      } catch {
        original.apply(this, [source, ...rest]);
      }
    } as typeof prototype.drawImage;
  } catch {
    // A canvas prototype that refuses the patch is not a reason to break the
    // board: images keep the engine's own behaviour.
  }
}

/** A `data:` URL for bytes just downloaded, so Excalidraw can install them. */
export function bytesToDataURL(bytes: Uint8Array, mimeType: string): string {
  let binary = '';
  const CHUNK = 0x8000;

  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}

function load(dataURL: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataURL;
  });
}

/**
 * Waits until the decoded bitmap is actually paintable.
 */
export async function ensurePaintable(
  dataURL: string,
  maxFrames = 30,
): Promise<void> {
  const image = await load(dataURL);
  if (!image || image.naturalWidth === 0 || image.naturalHeight === 0) return;

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;

  // A backgrounded tab stops firing animation frames: without a deadline
  // the wait below would never end and the file would never install.
  let expired = false;
  const timer = window.setTimeout(() => {
    expired = true;
  }, 3000);

  try {
    for (let frame = 0; frame < maxFrames; frame += 1) {
      if (expired) return;
      // Either clock may stall (background tab, throttled timers): whichever
      // fires first moves the wait forward, the deadline caps it.
      await Promise.race([
        new Promise((resolve) => requestAnimationFrame(resolve)),
        new Promise((resolve) => window.setTimeout(resolve, 250)),
      ]);
      if (expired) return;

      try {
        context.clearRect(0, 0, 1, 1);
        // A 1px draw averages the whole bitmap: any real picture answers with
        // a non-empty pixel on the first frames after the decode settles.
        context.drawImage(image, 0, 0, 1, 1);
        const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
        if (a !== 0 || r !== 0 || g !== 0 || b !== 0) return;
      } catch {
        return;
      }
    }
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Re-encodes a raster image through a canvas at its natural size.
 *
 * Files pasted into the board keep whatever the OS or camera wrote: exotic
 * color profiles or CMYK JPEGs that desktop WebViews decode differently from
 * browsers (the "inverted colors on Linux" report). A canvas roundtrip
 * normalizes to sRGB exactly as the local screen drew it, so every engine
 * decodes the same bytes. Returns `null` when the image cannot be decoded.
 */
export async function normalizeImage(
  dataURL: string,
): Promise<{ dataURL: string; mimeType: string } | null> {
  const mimeType = /^data:([^;,]+)/.exec(dataURL)?.[1] ?? 'image/png';
  if (mimeType.includes('svg')) return { dataURL, mimeType };

  const image = await load(dataURL);
  if (!image || image.width === 0 || image.height === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  const context = canvas.getContext('2d');
  if (!context) return null;

  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  // PNG keeps transparency and is lossless: the bytes change (sRGB, stripped
  // profile) but the pixels do not. JPEG/WebP only enter in the downscale
  // loop below, when the PNG no longer fits.
  return { dataURL: canvas.toDataURL('image/png'), mimeType: 'image/png' };
}

/**
 * The image at no more than [maxBytes], downscaled and re-encoded when needed.
 *
 * Returns `null` when it cannot be brought under the ceiling: the caller leaves
 * the image on the screen of whoever added it and says so, instead of refusing
 * the rest of the board.
 */
export async function shrinkImage(
  dataURL: string,
  maxBytes: number,
): Promise<{ dataURL: string; mimeType: string } | null> {
  const mimeType = /^data:([^;,]+)/.exec(dataURL)?.[1] ?? 'image/png';

  // An SVG is text and a canvas would rasterize it: it fits or it does not.
  if (mimeType.includes('svg')) {
    return binaryBytes(dataURL) <= maxBytes ? { dataURL, mimeType } : null;
  }

  const normalized = await normalizeImage(dataURL);
  if (!normalized) return null;

  if (binaryBytes(normalized.dataURL) <= maxBytes) return normalized;

  const image = await load(normalized.dataURL);
  if (!image || image.width === 0 || image.height === 0) return null;

  let scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  let quality = 0.85;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));

    const context = canvas.getContext('2d');
    if (!context) return null;

    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    // WebP first (it keeps the transparency of a drawing), then JPEG.
    for (const type of ['image/webp', 'image/jpeg']) {
      const encoded = canvas.toDataURL(type, quality);

      if (binaryBytes(encoded) <= maxBytes) return { dataURL: encoded, mimeType: type };
    }

    if (quality > 0.55) quality -= 0.15;
    else scale *= 0.7;
  }

  return null;
}
