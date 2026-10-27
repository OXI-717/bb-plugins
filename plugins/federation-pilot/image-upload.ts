import type {z} from 'zod';
import {imageUploadSchema} from './contract.ts';
import {imageFilename, validateImage} from './image-format.ts';

// A fixed upstream API, with bytes supplied by the initiating client. No host
// file reads and no caller-supplied URL, headers, method or destination path.
export async function uploadImage(port: number, input: z.infer<typeof imageUploadSchema>, signal: AbortSignal) {
  const bytes = Buffer.from(input.bytesBase64, 'base64');
  if (bytes.toString('base64') !== input.bytesBase64) throw Error('Invalid image encoding');
  const mime = validateImage(bytes, input.mimeType);
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(bytes)], {type: mime}), imageFilename(input.filename, mime));
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${input.projectId}/attachments`, {
    method: 'POST', body: form, redirect: 'error', signal,
  });
  const parts: Uint8Array[] = []; let length = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const {done, value} = await reader.read(); if (done) break;
        length += value.length;
        if (length > 16384) {await reader.cancel(); throw Error('Image upload response exceeds 16 KiB');}
        parts.push(value);
      }
    } finally {reader.releaseLock();}
  }
  return {status: response.status, contentType: response.headers.get('content-type') ?? 'application/octet-stream', bodyBase64: Buffer.concat(parts).toString('base64')};
}
