import pino from 'pino';
import { loadLoggingOptions, RotatingFileDestination } from './rotate.js';

/**
 * Structured logs with redaction.
 *
 * - Default destination is stderr: stdout is reserved for the MCP STDIO
 *   transport, and stderr keeps working for the HTTP transport and Windows
 *   services alike (the service wrapper additionally mirrors child stderr to
 *   a bounded `stderr.log`).
 * - With `LOG_FILE` set (the Windows service default) logs go to a rotating
 *   file: bounded size (`LOG_FILE_MAX_BYTES`), bounded count
 *   (`LOG_FILE_MAX_FILES`) and bounded retention (`LOG_FILE_MAX_AGE_DAYS`).
 * - Redaction: Authorization headers, passwords, cookies and anything named
 *   like a token/secret are censored before they reach any destination.
 *   Query strings and CDP frames are never logged by the callers.
 */
const options = loadLoggingOptions(process.env);

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'authorization',
  'password',
  'token',
  'cookies',
  '*.token',
  '*.password',
  '*.secret',
  '*.authorization',
  'tunnelToken',
  'bearerToken',
  'cdpGatewayToken',
];

export const logger = pino(
  {
    level: options.level,
    redact: {
      paths: LOG_REDACT_PATHS,
      censor: '[REDACTED]',
    },
  },
  options.file !== undefined
    ? new RotatingFileDestination(options.file, {
        maxBytes: options.maxBytes,
        maxFiles: options.maxFiles,
        maxAgeDays: options.maxAgeDays,
      })
    : pino.destination({ dest: 2, sync: true }),
);
