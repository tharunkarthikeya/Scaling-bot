import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Candidate documents, and where they live.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE SECOND THING THAT BLOCKS MORE THAN ONE INSTANCE. A passport arrives on
 *  the web process, which writes it and acknowledges Meta. Minutes later an OCR
 *  worker reads it back, and later still the CRM sync reads it again. On one
 *  container those are the same filesystem. On three they are not, and the
 *  document simply is not there — a failure that looks like a corrupt file and
 *  is actually a missing machine.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `STORAGE_DRIVER` picks the backend. `local` is the mounted volume this has
 * always used and stays the default, because it is correct for one instance and
 * it is what every existing deployment runs. `s3` is what more than one instance
 * requires, and `config.ts` refuses to start a non-default `ROLE` without it.
 *
 * ## Keys are the same on both sides
 *
 * `waId/docType/<timestamp>-<hash><ext>` — identical layout in a directory tree
 * and in a bucket, because `storageKey` is persisted in Mongo on every upload
 * row and those rows outlive any migration. A key written by the local driver is
 * a key the S3 driver would look for in the same place.
 *
 * That is what makes the switch mechanically simple and it is *not* the same as
 * making it free: documents already on the volume are not in the bucket until
 * somebody copies them there. Flipping the driver on a deployment with history
 * strands every existing document. Copy first, then switch.
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

export interface SaveParams {
  waId: string;
  docType: string;
  buffer: Buffer;
  mimeType: string;
  originalFilename?: string;
}

/** What a backend has to be able to do. Deliberately three methods. */
interface StorageBackend {
  readonly name: string;
  save(params: SaveParams, file: StoredFile): Promise<void>;
  read(storageKey: string): Promise<Buffer>;
  /** Proves at boot that documents can actually be written. */
  ensureReady(): Promise<void>;
}

/**
 * Builds the key for an upload.
 *
 * Shared by both backends so they cannot drift. `waId` and `docType` are both
 * from a controlled set, but they are sanitised anyway — a path separator here
 * would write outside the storage root on one driver and forge a prefix on the
 * other.
 */
function keyFor(params: SaveParams, sha256: string): string {
  const safeWaId = params.waId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeDocType = params.docType.replace(/[^a-zA-Z0-9_-]/g, '');
  const ext = extensionFor(params.mimeType, params.originalFilename);
  const filename = `${Date.now()}-${sha256.slice(0, 12)}${ext}`;
  return path.posix.join(safeWaId, safeDocType, filename);
}

/* ------------------------------------------------------------------ */
/* Local disk                                                          */
/* ------------------------------------------------------------------ */

class LocalBackend implements StorageBackend {
  readonly name = 'local';

  private absolute(storageKey: string): string {
    const root = path.resolve(config.STORAGE_PATH);
    const absolute = path.resolve(root, storageKey);
    if (!absolute.startsWith(root + path.sep) && absolute !== root) {
      throw new Error('refusing to touch a path outside the storage root');
    }
    return absolute;
  }

  async save(_params: SaveParams, file: StoredFile): Promise<void> {
    const absolute = this.absolute(file.storageKey);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, _params.buffer, { mode: 0o600 });
  }

  async read(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.absolute(storageKey));
  }

  async ensureReady(): Promise<void> {
    await fs.mkdir(path.resolve(config.STORAGE_PATH), { recursive: true });
  }
}

/* ------------------------------------------------------------------ */
/* S3-compatible                                                       */
/* ------------------------------------------------------------------ */

class S3Backend implements StorageBackend {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    // `config.ts` has already refused to start if any of these are missing when
    // the driver is s3, so the assertions here are for the type checker rather
    // than for the operator — they cannot fire at runtime.
    this.bucket = config.S3_BUCKET!;

    this.client = new S3Client({
      region: config.S3_REGION,
      // Set for R2, MinIO, Backblaze and friends; omitted for real AWS, where
      // the SDK derives the endpoint from the region.
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      },
    });
  }

  /**
   * The object key, which is the storage key plus the configured prefix.
   *
   * The prefix is applied here and nowhere else, so it never reaches Mongo. A
   * `storageKey` in the database is prefix-free and stays readable if the prefix
   * is ever changed — which is what makes one bucket safe to share between
   * staging and production.
   */
  private objectKey(storageKey: string): string {
    const prefix = config.S3_PREFIX.replace(/^\/+|\/+$/g, '');
    return prefix ? `${prefix}/${storageKey}` : storageKey;
  }

  async save(params: SaveParams, file: StoredFile): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(file.storageKey),
        Body: params.buffer,
        ContentType: params.mimeType,
        // The integrity check travels with the object rather than only living in
        // Mongo, so a document can be verified from the bucket alone.
        ChecksumSHA256: Buffer.from(file.sha256, 'hex').toString('base64'),
        Metadata: { sha256: file.sha256, doctype: params.docType },
      }),
    );
  }

  async read(storageKey: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(storageKey) }),
    );

    if (!response.Body) throw new Error(`object "${storageKey}" came back with no body`);

    // `transformToByteArray` buffers the whole object, which is what every
    // caller here wants: OCR posts the bytes as multipart and the CRM sync
    // attaches them. MEDIA_MAX_BYTES already bounds how large that can be.
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async ensureReady(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      // Fail at boot rather than on the first candidate's passport. A bucket
      // that cannot be reached is a deployment mistake, and the only cheap
      // moment to discover it is now.
      throw new Error(
        `S3 storage is not usable: bucket "${this.bucket}" could not be reached ` +
          `(endpoint ${config.S3_ENDPOINT ?? 'aws default'}, region ${config.S3_REGION}). ` +
          `Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

let backendInstance: StorageBackend | undefined;

function backend(): StorageBackend {
  // Lazily, so a `local` deployment never constructs an S3 client and an S3
  // deployment never touches the filesystem.
  backendInstance ??= config.STORAGE_DRIVER === 's3' ? new S3Backend() : new LocalBackend();
  return backendInstance;
}

/** Tests only. */
export function resetStorageBackendForTests(): void {
  backendInstance = undefined;
}

/** Which driver is live. Reported by `/metrics` and by `doctor`. */
export function storageDriver(): string {
  return backend().name;
}

/**
 * Writes one document and returns what the database needs to find it again.
 *
 * The SHA-256 is taken here, on the way in, and is the same value whichever
 * backend stores the bytes — so a document copied from a volume into a bucket
 * verifies against the row that was written when it arrived on disk.
 */
export async function saveFile(params: SaveParams): Promise<StoredFile> {
  const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');
  const file: StoredFile = {
    storageKey: keyFor(params, sha256),
    sha256,
    byteSize: params.buffer.byteLength,
  };

  await backend().save(params, file);

  logger.debug(
    { storageKey: file.storageKey, byteSize: file.byteSize, driver: backend().name },
    'file stored',
  );

  return file;
}

export async function readFile(storageKey: string): Promise<Buffer> {
  return backend().read(storageKey);
}

/**
 * Proves storage works before the server takes traffic.
 *
 * On `local` that is creating the directory. On `s3` it is a HeadBucket, which
 * is the cheapest call that distinguishes "the bucket is there and these
 * credentials can see it" from every kind of typo.
 */
export async function ensureStorageRoot(): Promise<void> {
  await backend().ensureReady();
  logger.info(
    {
      driver: backend().name,
      ...(config.STORAGE_DRIVER === 's3'
        ? { bucket: config.S3_BUCKET, prefix: config.S3_PREFIX || undefined }
        : { path: path.resolve(config.STORAGE_PATH) }),
    },
    'storage ready',
  );
}
