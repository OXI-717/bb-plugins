// Atomic verified thread export (.jsonl.gz + .sha256) prior to automated deletion.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadProtectionMeta } from "./permanent.js";

export const EXPORT_FORMAT = "oxi-bb-thread-export/v1";
const THREAD_ID_RE = /^thr_[a-zA-Z0-9_-]+$/;
const MAX_EXPORT_EVENTS = 200_000;
const EVENTS_PAGE_LIMIT = 200;

export interface ExportResult {
  archivePath: string;
  checksumPath: string;
  sha256: string;
  compressedBytes: number;
  eventCount: number;
}

export function validateExportDir(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes("\0")) {
    throw new Error("exportDir must not contain NUL bytes");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error("exportDir must be an absolute path");
  }
  if (trimmed.split(/[\\/]/).includes("..")) {
    throw new Error("exportDir must not contain '..' path segments");
  }
  const resolved = path.resolve(trimmed);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    throw new Error("exportDir must not be the filesystem root");
  }
  return resolved;
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  const stat = await lstat(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Export directory must be a real directory: ${dirPath}`);
  }
}

async function writeFileAtomic(
  finalPath: string,
  content: Buffer | string,
): Promise<void> {
  const tmpPath = `${finalPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    const fh = await open(tmpPath, "wx", 0o600);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, finalPath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function exportAllThreadEvents(
  bb: BbPluginApi,
  threadId: string,
  signal?: AbortSignal,
) {
  const events: Awaited<
    ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>
  > = [];
  let afterSeq: string | undefined;
  let lastNumericSeq = -Infinity;
  for (;;) {
    signal?.throwIfAborted();
    const page = await bb.sdk.threads.events.list({
      threadId,
      order: "asc",
      limit: String(EVENTS_PAGE_LIMIT),
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      signal,
    });
    if (page.length === 0) break;
    for (const event of page) {
      if (typeof event.seq !== "number" || event.seq <= lastNumericSeq) {
        throw new Error(
          `Non-monotonic event seq while exporting ${threadId}: ${String(event.seq)} <= ${String(lastNumericSeq)}`,
        );
      }
      lastNumericSeq = event.seq;
      events.push(event);
      if (events.length > MAX_EXPORT_EVENTS) {
        throw new Error(
          `Thread ${threadId} exceeds export safety limit (${MAX_EXPORT_EVENTS} events)`,
        );
      }
    }
    if (page.length < EVENTS_PAGE_LIMIT) break;
    afterSeq = String(lastNumericSeq);
  }
  return events;
}

export async function verifyExportArchive(
  archivePath: string,
  expectedThreadId: string,
  expectedEventCount: number,
): Promise<{ sha256: string; compressedBytes: number }> {
  const compressed = await readFile(archivePath);
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  const raw = gunzipSync(compressed).toString("utf8");
  const lines = raw.split("\n").filter((line) => line.length > 0);
  if (lines.length !== expectedEventCount + 1) {
    throw new Error(
      `Export verification line count mismatch for ${expectedThreadId}: got ${lines.length}, expected ${expectedEventCount + 1}`,
    );
  }
  const header = JSON.parse(lines[0]) as {
    format?: unknown;
    thread?: { id?: unknown };
    eventCount?: unknown;
  };
  if (
    header.format !== EXPORT_FORMAT ||
    header.thread?.id !== expectedThreadId ||
    header.eventCount !== expectedEventCount
  ) {
    throw new Error(`Export header verification failed for ${expectedThreadId}`);
  }
  let prevSeq = -Infinity;
  for (let i = 1; i < lines.length; i++) {
    const row = JSON.parse(lines[i]) as { seq?: unknown; threadId?: unknown };
    if (
      typeof row.seq !== "number" ||
      row.seq <= prevSeq ||
      (row.threadId !== undefined && row.threadId !== expectedThreadId)
    ) {
      throw new Error(
        `Export event verification failed at line ${i + 1} for ${expectedThreadId}`,
      );
    }
    prevSeq = row.seq;
  }
  return { sha256, compressedBytes: compressed.byteLength };
}

function monthBucket(timestampMs: number): string {
  const d = new Date(timestampMs);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export async function exportAndVerifyThread(
  bb: BbPluginApi,
  thread: Record<string, unknown> & { id: string; archivedAt: number | null },
  metadata: ThreadProtectionMeta | undefined,
  exportDir: string,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ExportResult> {
  if (!THREAD_ID_RE.test(thread.id)) {
    throw new Error(`Refusing to export invalid thread ID: ${thread.id}`);
  }
  const rootDir = validateExportDir(exportDir);
  if (!rootDir) {
    throw new Error("exportDir must be configured before exporting threads");
  }
  await ensurePrivateDir(rootDir);
  const bucketDir = path.join(rootDir, monthBucket(thread.archivedAt ?? now));
  await ensurePrivateDir(bucketDir);

  const events = await exportAllThreadEvents(bb, thread.id, signal);
  const header = {
    format: EXPORT_FORMAT,
    exportedAt: now,
    thread,
    metadata: metadata ?? {
      permanent: false,
      unarchiveCount: 0,
      lastUnarchivedAt: null,
    },
    eventCount: events.length,
    firstSeq: events.length > 0 ? events[0].seq : null,
    lastSeq: events.length > 0 ? events[events.length - 1].seq : null,
  };
  const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
  const compressed = gzipSync(Buffer.from(`${lines.join("\n")}\n`, "utf8"), {
    level: 6,
  });

  const fileName = `${thread.id}.jsonl.gz`;
  const archivePath = path.join(bucketDir, fileName);
  const checksumPath = `${archivePath}.sha256`;

  await writeFileAtomic(archivePath, compressed);
  const verified = await verifyExportArchive(
    archivePath,
    thread.id,
    events.length,
  );
  const checksumLine = `${verified.sha256}  ${fileName}\n`;
  await writeFileAtomic(checksumPath, checksumLine);

  const writtenChecksum = (await readFile(checksumPath, "utf8")).trim();
  if (writtenChecksum !== `${verified.sha256}  ${fileName}`) {
    throw new Error(`Checksum file verification failed for ${thread.id}`);
  }

  return {
    archivePath,
    checksumPath,
    sha256: verified.sha256,
    compressedBytes: verified.compressedBytes,
    eventCount: events.length,
  };
}
