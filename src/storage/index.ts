import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Storage is behind this interface so the local-disk backend can be swapped for
 * S3/R2 without touching callers. On Dokploy STORAGE_PATH must be a mounted
 * volume — the container filesystem does not survive a redeploy.
 */
export interface StoredFile {
  storageKey: string;
  sha256: string;
  byteSize: number;
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
};

export function extensionFor(mimeType: string, originalFilename?: string): string {
  const known = EXTENSION_BY_MIME[mimeType.split(';')[0]!.trim().toLowerCase()];
  if (known) return known;

  const fromName = originalFilename ? path.extname(originalFilename) : '';
  // Only trust the candidate-supplied extension if it looks like one.
  return /^\.[a-z0-9]{1,8}$/i.test(fromName) ? fromName.toLowerCase() : '.bin';
}

export async function saveFile(params: {
  waId: string;
  docType: string;
  buffer: Buffer;
  mimeType: string;
  originalFilename?: string;
}): Promise<StoredFile> {
  const { waId, docType, buffer, mimeType, originalFilename } = params;

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = extensionFor(mimeType, originalFilename);

  // waId and docType are both from a controlled set, but sanitise anyway —
  // a path separator here would write outside the storage root.
  const safeWaId = waId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeDocType = docType.replace(/[^a-zA-Z0-9_-]/g, '');
  const filename = `${Date.now()}-${sha256.slice(0, 12)}${ext}`;

  const relativeDir = path.join(safeWaId, safeDocType);
  const storageKey = path.posix.join(safeWaId, safeDocType, filename);

  const absoluteDir = path.resolve(config.STORAGE_PATH, relativeDir);
  const root = path.resolve(config.STORAGE_PATH);
  if (!absoluteDir.startsWith(root + path.sep) && absoluteDir !== root) {
    throw new Error('refusing to write outside the storage root');
  }

  await fs.mkdir(absoluteDir, { recursive: true });
  await fs.writeFile(path.join(absoluteDir, filename), buffer, { mode: 0o600 });

  logger.debug({ storageKey, byteSize: buffer.byteLength }, 'file stored');

  return { storageKey, sha256, byteSize: buffer.byteLength };
}

export async function readFile(storageKey: string): Promise<Buffer> {
  const root = path.resolve(config.STORAGE_PATH);
  const absolute = path.resolve(root, storageKey);
  if (!absolute.startsWith(root + path.sep)) {
    throw new Error('refusing to read outside the storage root');
  }
  return fs.readFile(absolute);
}

export async function ensureStorageRoot(): Promise<void> {
  await fs.mkdir(path.resolve(config.STORAGE_PATH), { recursive: true });
}
