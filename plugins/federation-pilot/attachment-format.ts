import {IMAGE_MAX_BYTES, ImageTransferError, validateImage} from './image-format.ts';
// Only client-selected bytes; files never become inline content via image GET.
export function validateAttachment(bytes: Uint8Array, mime: string): string {
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES) throw new ImageTransferError(413, 'Remote attachments must be between 1 byte and 4 MiB.');
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime) || mime.length > 100 || mime !== mime.toLowerCase()) throw new ImageTransferError(415, 'Invalid attachment MIME type.');
  if (mime.startsWith('image/')) return validateImage(bytes, mime);
  return mime;
}
export function isAttachmentPath(path: string): boolean {
  return path.length <= 255 && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(path) && !path.includes('..');
}
export function attachmentFilename(name: string): string {
  const leaf = name.split(/[\\/]/).at(-1) || 'file';
  return ('file-' + leaf.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/\.{2,}/g, '-')).slice(0, 200);
}
