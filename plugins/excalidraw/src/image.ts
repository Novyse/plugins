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

function load(dataURL: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataURL;
  });
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

  if (binaryBytes(dataURL) <= maxBytes) return { dataURL, mimeType };

  const image = await load(dataURL);
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
