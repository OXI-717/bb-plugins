import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import type {RemoteConfig} from './configuration.ts';
import {PrimaryCollisionError} from './ownership.ts';
import {imageUploadSchema, uploadedImageSchema} from './contract.ts';
import {IMAGE_MAX_BASE64, ImageTransferError, isImagePath, validateImage} from './image-format.ts';

type Upstream = {status: number; contentType: string; bodyBase64: string};
type Dependencies = {
  selected(serverId: string): Promise<RemoteConfig>;
  exclusive(c: RemoteConfig, ids: string[]): Promise<void>;
  upload(c: RemoteConfig, input: z.infer<typeof imageUploadSchema>): Promise<Upstream>;
  get(c: RemoteConfig, path: string): Promise<Upstream>;
};
const identity = {serverId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), projectId: z.string().regex(/^proj_[a-z0-9]+$/)};
const uploadRequest = imageUploadSchema.extend({serverId: identity.serverId}).strict();
const contentQuery = z.object({...identity, path: z.string().refine(isImagePath)}).strict();

export async function readBoundedJson(request: Request): Promise<unknown> {
  const limit = IMAGE_MAX_BASE64 + 4096;
  if (Number(request.headers.get('content-length')) > limit) throw new ImageTransferError(413, 'Image upload envelope exceeds the limit.');
  const reader = request.body?.getReader();
  if (!reader) throw new ImageTransferError(400, 'Missing upload body.');
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new ImageTransferError(413, 'Image upload envelope exceeds the limit.'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new ImageTransferError(400, 'Invalid image upload JSON.'); }
}

export function registerImageRoutes(bb: BbPluginApi, deps: Dependencies) {
  async function authorize(serverId: string, projectId: string, write: boolean, previous?: RemoteConfig) {
    const c = await deps.selected(serverId);
    if (c.projectId !== projectId || projectId === 'proj_personal') throw new ImageTransferError(403, 'Image is outside the configured remote project.');
    if (previous && JSON.stringify(c) !== JSON.stringify(previous)) throw new ImageTransferError(409, 'Remote configuration changed during image transfer.');
    if (write && !c.allowWrites) throw new ImageTransferError(403, 'Remote connection is read-only.');
    await deps.exclusive(c, [projectId]);
    const current = await deps.selected(serverId);
    if (JSON.stringify(c) !== JSON.stringify(current)) throw new ImageTransferError(409, 'Remote configuration changed during image transfer.');
    return c;
  }
  function failure(e: unknown): Response {
    const primary = e instanceof PrimaryCollisionError;
    const status = primary ? 409 : e instanceof ImageTransferError ? e.status : 503;
    return Response.json({error: {code: primary ? 'federation_primary_owner' : 'federation_image_error', message: e instanceof Error ? e.message : 'Image transfer failed'}}, {
      status, headers: {'cache-control': 'no-store', ...(primary ? {'x-bb-federation-primary': e.id} : {})},
    });
  }
  bb.http.route('POST', '/image-upload', async ctx => {
    try {
      const parsed = uploadRequest.safeParse(await readBoundedJson(ctx.req.raw));
      if (!parsed.success) throw new ImageTransferError(400, 'Invalid image upload envelope.');
      const {serverId, ...input} = parsed.data;
      const bytes = Buffer.from(input.bytesBase64, 'base64');
      if (bytes.toString('base64') !== input.bytesBase64) throw new ImageTransferError(400, 'Noncanonical image encoding.');
      validateImage(bytes, input.mimeType);
      const c = await authorize(serverId, input.projectId, true);
      const result = await deps.upload(c, input); // No retries: upload may already have succeeded.
      await authorize(serverId, input.projectId, true, c);
      if (result.status < 200 || result.status >= 300) throw new ImageTransferError(result.status >= 400 && result.status < 600 ? result.status : 502, `Remote image upload returned HTTP ${result.status}.`);
      let data: z.infer<typeof uploadedImageSchema>;
      try { data = uploadedImageSchema.parse(JSON.parse(Buffer.from(result.bodyBase64, 'base64').toString('utf8'))); }
      catch { throw new ImageTransferError(502, 'Remote image upload returned invalid metadata.'); }
      if (data.sourceProjectId && data.sourceProjectId !== input.projectId) throw new ImageTransferError(502, 'Remote image upload returned a different source project.');
      if (data.sizeBytes !== bytes.length || data.mimeType !== input.mimeType) throw new ImageTransferError(502, 'Remote image upload metadata does not match the file.');
      // Older BB replies omit sourceProjectId; the fixed upload URL already
      // establishes it. Never accept a conflicting remote-provided identity.
      return Response.json({...data, sourceProjectId: input.projectId}, {status: 201, headers: {'cache-control': 'no-store'}});
    } catch (e) { return failure(e); }
  });
  bb.http.route('GET', '/image-content', async ctx => {
    try {
      const url = new URL(ctx.req.url);
      if ([...url.searchParams.keys()].length !== 3) throw new ImageTransferError(400, 'Invalid image address.');
      const parsed = contentQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!parsed.success) throw new ImageTransferError(400, 'Invalid image address.');
      const {serverId, projectId, path} = parsed.data;
      const c = await authorize(serverId, projectId, false);
      const result = await deps.get(c, `/api/v1/projects/${projectId}/attachments/content?${new URLSearchParams({path})}`);
      await authorize(serverId, projectId, false, c);
      if (result.status !== 200) throw new ImageTransferError(result.status >= 400 && result.status < 600 ? result.status : 502, `Remote image returned HTTP ${result.status}.`);
      const bytes = Buffer.from(result.bodyBase64, 'base64');
      const mime = validateImage(bytes, result.contentType.split(';')[0].trim().toLowerCase());
      // Only inert raster media crosses this same-origin GET. Never forward
      // upstream headers, HTML, SVG, redirects, cookies or authorization.
      return new Response(bytes, {headers: {'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer'}});
    } catch (e) { return failure(e); }
  });
}
