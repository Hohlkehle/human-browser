import { Writable } from 'node:stream';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_LOG_FILE_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB per file
export const DEFAULT_LOG_FILE_MAX_FILES = 5; // browser-mcp.log + .1 .. .5
export const DEFAULT_LOG_FILE_MAX_AGE_DAYS = 14;

export interface RotatingFileOptions {
  /** Rotate once the primary file would exceed this size. Default 10 MiB. */
  maxBytes?: number;
  /** Keep at most this many rotated siblings (`file.1` .. `file.N`). Default 5. */
  maxFiles?: number;
  /** Delete rotated siblings older than this many days. Default 14. */
  maxAgeDays?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

interface ResolvedOptions {
  maxBytes: number;
  maxFiles: number;
  maxAgeDays: number;
  now: () => Date;
}

function resolveOptions(options: RotatingFileOptions): ResolvedOptions {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_FILE_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_LOG_FILE_MAX_FILES;
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_LOG_FILE_MAX_AGE_DAYS;
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
    throw new Error('maxBytes must be an integer >= 1024');
  }
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 999) {
    throw new Error('maxFiles must be an integer between 1 and 999');
  }
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error('maxAgeDays must be a positive number');
  }
  return { maxBytes, maxFiles, maxAgeDays, now: options.now ?? (() => new Date()) };
}

/**
 * A pino-compatible synchronous rotating file destination.
 *
 * Structured service logs must be bounded: once `file` would exceed
 * `maxBytes` it is rotated to `file.1` (newest) .. `file.N` (oldest);
 * siblings beyond `maxFiles` are deleted and siblings older than
 * `maxAgeDays` are pruned on open and after every rotation. Writes use
 * `fs.writeSync` so a log line can never be lost to an unflushed buffer
 * during a crash or a forced service stop.
 */
export class RotatingFileDestination extends Writable {
  private readonly file: string;
  private readonly options: ResolvedOptions;
  private fd: number | undefined;
  private size = 0;
  private isClosed = false;

  constructor(file: string, options: RotatingFileOptions = {}) {
    super({ decodeStrings: false });
    if (!file) throw new Error('file must be a non-empty path');
    this.file = file;
    this.options = resolveOptions(options);
  }

  /** Current size in bytes of the primary file (0 while closed). */
  get currentSize(): number {
    return this.size;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.ensureOpen();
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      if (this.size + data.byteLength > this.options.maxBytes) {
        this.rotate();
      }
      writeSync(this.fdOrThrow(), data, 0, data.byteLength);
      this.size += data.byteLength;
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Rotate now regardless of size (exposed for tests and operators). */
  rotate(): void {
    this.closeFd();
    const { maxFiles } = this.options;
    // Delete the oldest sibling, then shift .i -> .i+1 from the top down.
    this.unlinkQuietly(this.siblingName(maxFiles));
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const from = this.siblingName(i);
      try {
        renameSync(from, this.siblingName(i + 1));
      } catch {
        // Missing siblings are normal right after deployment.
      }
    }
    try {
      renameSync(this.file, this.siblingName(1));
    } catch {
      // Primary file may not exist yet; nothing to rotate.
    }
    this.cleanupByAge();
    this.openFd();
  }

  /** pino calls flush() on destinations that expose it; writes are synchronous. */
  flush(): void {
    // No-op: writeSync hands data to the OS immediately.
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.isClosed = true;
    this.closeFd();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.isClosed = true;
    this.closeFd();
    callback(error);
  }

  private fdOrThrow(): number {
    if (this.fd === undefined) throw new Error(`log file is closed: ${this.file}`);
    return this.fd;
  }

  private siblingName(index: number): string {
    return `${this.file}.${index}`;
  }

  private ensureOpen(): void {
    if (this.isClosed) throw new Error(`log destination is closed: ${this.file}`);
    if (this.fd !== undefined) return;
    mkdirSync(dirname(this.file), { recursive: true });
    // An already-oversized file (e.g. left over from a previous run) is
    // rotated before the first write so the limit always holds.
    try {
      const existing = statSync(this.file);
      if (existing.size >= this.options.maxBytes) {
        this.cleanupByAge();
        this.rotate();
        return;
      }
    } catch {
      // File does not exist yet.
    }
    this.cleanupByAge();
    this.openFd();
  }

  private openFd(): void {
    this.fd = openSync(this.file, 'a');
    this.size = statSync(this.file).size;
  }

  private closeFd(): void {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // Already closed by the OS; nothing to do.
      }
      this.fd = undefined;
      this.size = 0;
    }
  }

  private unlinkQuietly(path: string): void {
    try {
      unlinkSync(path);
    } catch {
      // Missing file is fine.
    }
  }

  /** Delete rotated siblings (`<file>.N`) whose mtime is beyond maxAgeDays. */
  private cleanupByAge(): void {
    const cutoff = this.options.now().getTime() - this.options.maxAgeDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = readdirSync(dirname(this.file));
    } catch {
      return;
    }
    const base = `${this.file.split(/[\\/]/).pop() ?? this.file}.`;
    for (const entry of entries) {
      if (!entry.startsWith(base)) continue;
      const suffix = entry.slice(base.length);
      if (!/^\d{1,3}$/.test(suffix)) continue;
      const index = Number(suffix);
      if (index < 1 || index > this.options.maxFiles) continue;
      const path = join(dirname(this.file), entry);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {
        // Concurrent deletion is fine.
      }
    }
  }
}

export interface LoggingOptions {
  level: string;
  /** When set, structured logs go to this rotating file instead of stderr. */
  file?: string;
  maxBytes: number;
  maxFiles: number;
  maxAgeDays: number;
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/**
 * Parses the LOG_* environment variables. Secrets never appear here; the
 * redaction list in `logger.ts` is the second line of defense.
 */
export function loadLoggingOptions(environment: NodeJS.ProcessEnv = process.env): LoggingOptions {
  const file = environment.LOG_FILE;
  return {
    level: environment.LOG_LEVEL ?? 'info',
    ...(file !== undefined && file !== '' ? { file } : {}),
    maxBytes: positiveInt('LOG_FILE_MAX_BYTES', environment.LOG_FILE_MAX_BYTES, DEFAULT_LOG_FILE_MAX_BYTES),
    maxFiles: positiveInt('LOG_FILE_MAX_FILES', environment.LOG_FILE_MAX_FILES, DEFAULT_LOG_FILE_MAX_FILES),
    maxAgeDays: positiveInt('LOG_FILE_MAX_AGE_DAYS', environment.LOG_FILE_MAX_AGE_DAYS, DEFAULT_LOG_FILE_MAX_AGE_DAYS),
  };
}
