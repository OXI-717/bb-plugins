// The host RPC has an 8 MiB JSON limit. A 4 MiB raster image fits after base64.
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MAX_BASE64 = 4 * Math.ceil(IMAGE_MAX_BYTES / 3);
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMime = typeof IMAGE_MIMES[number];
export class ImageTransferError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function imageMime(bytes: Uint8Array): ImageMime | null {
  const starts = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  if (bytes.length >= 24 && starts(137,80,78,71,13,10,26,10)) return 'image/png';
  if (bytes.length >= 4 && starts(255,216,255)) return 'image/jpeg';
  if (bytes.length >= 13 && starts(71,73,70,56) && [55,57].includes(bytes[4]) && bytes[5] === 97) return 'image/gif';
  if (bytes.length >= 16 && starts(82,73,70,70) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  return null;
}
export function validateImage(bytes: Uint8Array, mime: string): ImageMime {
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) throw new ImageTransferError(413, 'Remote images must be between 1 byte and 4 MiB.');
  const detected = imageMime(bytes);
  if (!detected || detected !== mime) throw new ImageTransferError(415, 'Remote images support PNG, JPEG, GIF and WebP with matching content and MIME type.');
  return detected;
}
export function imageFilename(name: string, mime: ImageMime): string {
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime];
  const stem = name.split(/[\\/]/).at(-1)?.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100) || 'image';
  return `${stem}.${extension}`;
}
// BB stores uploaded attachments as one sanitized filename, never a host path.
export function isImagePath(path: string): boolean {
  return path.length <= 255 && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(png|jpe?g|gif|webp)$/i.test(path) && !path.includes('..');
}
