/**
 * Loads learned site specs from a local directory.
 *
 * Specs live OUTSIDE version control on purpose: they record a site's internal
 * data format, endpoints and quirks, and the project's rule is that nothing
 * like that is ever published. The repository ships the engine, the format
 * documentation and a synthetic example; the learned files stay on the machine
 * (`SITE_SPECS_DIR`, default `<cwd>/specs` — see `.gitignore`).
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { SiteSpec, SpecOp, SpecParam } from './types.js';

export type SpecErrorCode =
  | 'specs_dir_missing'
  | 'spec_not_found'
  | 'spec_invalid'
  | 'spec_unknown_op';

export class SpecError extends Error {
  readonly code: SpecErrorCode;

  constructor(code: SpecErrorCode, message: string) {
    super(message);
    this.name = 'SpecError';
    this.code = code;
  }
}

export interface SpecOpSummary {
  readonly name: string;
  readonly description: string;
  readonly transport: 'http' | 'browser-mcp';
  readonly params: readonly SpecParam[];
  /** True when the op carries the holdout `check` contract. */
  readonly hasCheck: boolean;
}

export interface SpecSummary {
  readonly name: string;
  readonly displayName: string;
  readonly baseUrl: string | null;
  readonly description: string;
  readonly learnedAt: string | null;
  readonly ops: readonly SpecOpSummary[];
}

export interface SpecStore {
  /** Directory this store reads; reported in errors so the user can fix it. */
  readonly dir: string;
  list(): Promise<readonly SpecSummary[]>;
  /** Loads one spec by its `name` (the file base name, no path allowed). */
  get(site: string): Promise<SiteSpec>;
  /** Loads a spec and resolves one op (unknown op → `spec_unknown_op`). */
  op(site: string, op: string): Promise<{ spec: SiteSpec; op: SpecOp }>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

const OP_NAME = /^[A-Za-z0-9_.-]+$/;

function validateSpec(parsed: unknown, file: string): SiteSpec {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpecError('spec_invalid', `${file}: spec must be a JSON object`);
  }
  const spec = parsed as Record<string, unknown>;
  const name = asString(spec.name);
  if (name === null) {
    throw new SpecError('spec_invalid', `${file}: missing "name"`);
  }
  const ops = spec.ops;
  if (ops === null || typeof ops !== 'object' || Array.isArray(ops)) {
    throw new SpecError('spec_invalid', `${file}: missing "ops"`);
  }
  for (const [opName, op] of Object.entries(ops as Record<string, unknown>)) {
    if (!OP_NAME.test(opName)) {
      throw new SpecError('spec_invalid', `${file}: op name "${opName}" has unsupported characters`);
    }
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new SpecError('spec_invalid', `${file}: op "${opName}" must be an object`);
    }
    const record = op as Record<string, unknown>;
    const transport = record.transport;
    if (transport !== undefined && transport !== 'http' && transport !== 'browser-mcp') {
      throw new SpecError('spec_invalid', `${file}: op "${opName}" has unknown transport "${String(transport)}"`);
    }
    if (asString(record.url) === null) {
      throw new SpecError('spec_invalid', `${file}: op "${opName}" needs a "url"`);
    }
  }
  return parsed as SiteSpec;
}

function summarise(spec: SiteSpec): SpecSummary {
  return {
    name: spec.name,
    displayName: spec.displayName ?? spec.name,
    baseUrl: spec.baseUrl ?? null,
    description: spec.description ?? '',
    learnedAt: spec.learned_at ?? null,
    ops: Object.entries(spec.ops).map(([name, op]) => ({
      name,
      description: op.description ?? '',
      transport: op.transport ?? 'http',
      params: op.params ?? [],
      hasCheck: (op.check?.expect ?? []).length > 0,
    })),
  };
}

/** Names are file base names: no separators, no traversal, no extension games. */
function specPath(dir: string, site: string): string {
  const cleaned = site.trim().replace(/\.json$/i, '');
  if (cleaned === '' || cleaned.includes('/') || cleaned.includes('\\') || cleaned.includes('..')) {
    throw new SpecError(
      'spec_not_found',
      `invalid spec name ${JSON.stringify(site)}: use the spec's "name" (a bare file name, no path)`,
    );
  }
  return path.join(dir, `${cleaned}.json`);
}

async function readSpecFile(file: string): Promise<SiteSpec> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      throw new SpecError('spec_not_found', `no spec file at ${file}`);
    }
    throw new SpecError('spec_invalid', `cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SpecError('spec_invalid', `${file} is not valid JSON: ${(error as Error).message}`);
  }
  return validateSpec(parsed, file);
}

export function createSpecStore(dir: string): SpecStore {
  const resolvedDir = path.resolve(dir);

  async function requireDir(): Promise<string> {
    try {
      const entries = await readdir(resolvedDir);
      void entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SpecError(
          'specs_dir_missing',
          `no site-spec directory at ${resolvedDir}; point SITE_SPECS_DIR at your local specs folder (the learned JSON files are deliberately not committed)`,
        );
      }
      throw new SpecError('specs_dir_missing', `cannot list ${resolvedDir}: ${(error as Error).message}`);
    }
    return resolvedDir;
  }

  return {
    dir: resolvedDir,

    async list(): Promise<readonly SpecSummary[]> {
      const directory = await requireDir();
      const files = (await readdir(directory)).filter((entry) => entry.toLowerCase().endsWith('.json'));
      const summaries: SpecSummary[] = [];
      for (const file of files.sort()) {
        // A broken spec must not hide the healthy ones: report it as an entry.
        try {
          summaries.push(summarise(await readSpecFile(path.join(directory, file))));
        } catch (error) {
          summaries.push({
            name: file.replace(/\.json$/i, ''),
            displayName: file,
            baseUrl: null,
            description: `INVALID: ${error instanceof Error ? error.message : String(error)}`,
            learnedAt: null,
            ops: [],
          });
        }
      }
      return summaries;
    },

    async get(site: string): Promise<SiteSpec> {
      const directory = await requireDir();
      return readSpecFile(specPath(directory, site));
    },

    async op(site: string, op: string): Promise<{ spec: SiteSpec; op: SpecOp }> {
      const spec = await this.get(site);
      const found = spec.ops[op];
      if (found === undefined) {
        const available = Object.keys(spec.ops).join(', ') || '(none)';
        throw new SpecError('spec_unknown_op', `spec "${spec.name}" has no op "${op}"; available: ${available}`);
      }
      return { spec, op: found };
    },
  };
}
