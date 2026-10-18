import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACT_PATHS } from '../../src/logging/logger.js';
import {
  DEFAULT_LOG_FILE_MAX_AGE_DAYS,
  DEFAULT_LOG_FILE_MAX_BYTES,
  DEFAULT_LOG_FILE_MAX_FILES,
  loadLoggingOptions,
  RotatingFileDestination,
} from '../../src/logging/rotate.js';

describe('RotatingFileDestination', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-rotation-'));
    file = join(dir, 'browser-mcp.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(dest: Writable, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      dest.write(line, 'utf8', (error) => (error ? reject(error) : resolve()));
    });
  }

  it('appends lines to the primary file', async () => {
    const dest = new RotatingFileDestination(file, { maxBytes: 4096 });
    await write(dest, '{"level":30,"msg":"one"}\n');
    await write(dest, '{"level":30,"msg":"two"}\n');
    await new Promise<void>((resolve) => dest.end(resolve));

    expect(readFileSync(file, 'utf8')).toBe('{"level":30,"msg":"one"}\n{"level":30,"msg":"two"}\n');
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it('creates missing parent directories on first write', async () => {
    const nested = join(dir, 'logs', 'deep', 'browser-mcp.log');
    const dest = new RotatingFileDestination(nested, { maxBytes: 4096 });
    await write(dest, 'hello\n');
    await new Promise<void>((resolve) => dest.end(resolve));
    expect(readFileSync(nested, 'utf8')).toBe('hello\n');
  });

  it('rotates to .1 when the size cap would be exceeded', async () => {
    const dest = new RotatingFileDestination(file, { maxBytes: 1024 });
    const line = 'x'.repeat(600) + '\n';

    await write(dest, line); // 601 bytes, no rotation yet
    expect(existsSync(`${file}.1`)).toBe(false);
    await write(dest, line); // would exceed 1024 -> rotate first

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(line);
    expect(readFileSync(file, 'utf8')).toBe(line);
    expect(statSync(file).size).toBeLessThanOrEqual(1024);
    await new Promise<void>((resolve) => dest.end(resolve));
  });

  it('shifts siblings and drops the oldest beyond maxFiles', async () => {
    const dest = new RotatingFileDestination(file, { maxBytes: 1024, maxFiles: 2 });
    const line = (tag: string) => `${tag}:${'y'.repeat(600)}\n`;

    await write(dest, line('a'));
    await write(dest, line('b')); // rotates a -> .1
    await write(dest, line('c')); // rotates b -> .1, a -> .2
    await write(dest, line('d')); // rotates c -> .1, b -> .2, a dropped

    expect(readFileSync(`${file}.1`, 'utf8')).toBe(line('c'));
    expect(readFileSync(`${file}.2`, 'utf8')).toBe(line('b'));
    expect(existsSync(`${file}.3`)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(line('d'));
    await new Promise<void>((resolve) => dest.end(resolve));
  });

  it('rotates an already-oversized leftover file before the first write', async () => {
    writeFileSync(file, 'z'.repeat(2048));
    const dest = new RotatingFileDestination(file, { maxBytes: 1024 });
    await write(dest, 'fresh\n');
    await new Promise<void>((resolve) => dest.end(resolve));

    expect(readFileSync(`${file}.1`, 'utf8')).toBe('z'.repeat(2048));
    expect(readFileSync(file, 'utf8')).toBe('fresh\n');
  });

  it('prunes rotated siblings older than maxAgeDays', async () => {
    const clock = new Date('2026-08-20T12:00:00Z');
    const dest = new RotatingFileDestination(file, {
      maxBytes: 1024,
      maxAgeDays: 7,
      now: () => clock,
    });

    // Seed an "old" sibling (10 days) and a "fresh" sibling (1 day).
    writeFileSync(`${file}.1`, 'fresh-sibling\n');
    writeFileSync(`${file}.2`, 'old-sibling\n');
    const old = new Date(clock.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fresh = new Date(clock.getTime() - 1 * 24 * 60 * 60 * 1000);
    utimesSync(`${file}.2`, old, old);
    utimesSync(`${file}.1`, fresh, fresh);

    await write(dest, 'trigger cleanup\n');
    await new Promise<void>((resolve) => dest.end(resolve));

    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(false);
  });

  it('keeps rotating across many cycles without leaking file handles', async () => {
    const dest = new RotatingFileDestination(file, { maxBytes: 1024, maxFiles: 3 });
    const line = 'q'.repeat(400) + '\n';
    for (let i = 0; i < 20; i += 1) {
      await write(dest, `${i}:${line}`);
    }
    await new Promise<void>((resolve) => dest.end(resolve));

    expect(statSync(file).size).toBeLessThanOrEqual(1024);
    expect(existsSync(`${file}.3`)).toBe(true);
    expect(existsSync(`${file}.4`)).toBe(false);
  });

  it('rejects invalid options', () => {
    expect(() => new RotatingFileDestination('', {})).toThrow(/non-empty/);
    expect(() => new RotatingFileDestination(file, { maxBytes: 10 })).toThrow(/maxBytes/);
    expect(() => new RotatingFileDestination(file, { maxFiles: 0 })).toThrow(/maxFiles/);
    expect(() => new RotatingFileDestination(file, { maxAgeDays: 0 })).toThrow(/maxAgeDays/);
  });

  it('exposes flush() as a no-op and reports currentSize', async () => {
    const dest = new RotatingFileDestination(file, { maxBytes: 4096 });
    await write(dest, 'abc\n');
    expect(dest.currentSize).toBe(4);
    expect(() => dest.flush()).not.toThrow();
    await new Promise<void>((resolve) => dest.end(resolve));
  });
});

describe('loadLoggingOptions', () => {
  it('defaults to stderr with bounded rotation settings', () => {
    const options = loadLoggingOptions({});
    expect(options.file).toBeUndefined();
    expect(options.level).toBe('info');
    expect(options.maxBytes).toBe(DEFAULT_LOG_FILE_MAX_BYTES);
    expect(options.maxFiles).toBe(DEFAULT_LOG_FILE_MAX_FILES);
    expect(options.maxAgeDays).toBe(DEFAULT_LOG_FILE_MAX_AGE_DAYS);
  });

  it('parses LOG_* overrides', () => {
    const options = loadLoggingOptions({
      LOG_FILE: 'C:\\ProgramData\\browser-mcp\\logs\\browser-mcp.log',
      LOG_LEVEL: 'warn',
      LOG_FILE_MAX_BYTES: '2048',
      LOG_FILE_MAX_FILES: '3',
      LOG_FILE_MAX_AGE_DAYS: '2',
    });
    expect(options.file).toBe('C:\\ProgramData\\browser-mcp\\logs\\browser-mcp.log');
    expect(options.level).toBe('warn');
    expect(options.maxBytes).toBe(2048);
    expect(options.maxFiles).toBe(3);
    expect(options.maxAgeDays).toBe(2);
  });

  it('rejects non-positive rotation values', () => {
    expect(() => loadLoggingOptions({ LOG_FILE_MAX_BYTES: '0' })).toThrow(/LOG_FILE_MAX_BYTES/);
    expect(() => loadLoggingOptions({ LOG_FILE_MAX_FILES: 'abc' })).toThrow(/LOG_FILE_MAX_FILES/);
    expect(() => loadLoggingOptions({ LOG_FILE_MAX_AGE_DAYS: '-1' })).toThrow(/LOG_FILE_MAX_AGE_DAYS/);
  });
});

describe('log redaction', () => {
  it('censors token-like fields wherever they appear', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino(
      { level: 'info', redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } },
      sink,
    );

    log.info(
      {
        token: 'secret-1',
        tunnelToken: 'secret-2',
        bearerToken: 'secret-3',
        nested: { token: 'secret-4', password: 'secret-5', secret: 'secret-6' },
        req: { headers: { authorization: 'Bearer secret-7' } },
        plain: 'visible',
      },
      'redaction check',
    );

    const line = lines.join('');
    expect(line).toContain('"plain":"visible"');
    for (let i = 1; i <= 7; i += 1) {
      expect(line).not.toContain(`secret-${i}`);
    }
    expect(line).toContain('[REDACTED]');
  });
});
