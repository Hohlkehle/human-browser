/**
 * The pick engine: turns a raw response into structured rows using the regex
 * "picks" of a learned spec. This is a faithful port of the Python caller that
 * shipped with the `graber-web` skill (`scripts/site_op.py`), so existing spec
 * files keep working unchanged:
 *
 *  - every pattern is applied with DOTALL (`re.S` / the `s` flag);
 *  - a pick with no groups returns the whole match; with groups it returns the
 *    first non-None group; with EVERY group named it returns `{name: value}`
 *    (the feature that yields `title`/`loc` dicts). A pattern mixing named and
 *    unnamed groups is treated as plain groups — an unnamed group of yours in a
 *    named pattern silently drops the dict, so don't mix on purpose;
 *  - `all: true` → list of matches; `dedupe: true` → ordered dedupe;
 *  - `decode` applies to the single-match path only (never to `all`).
 */

import { compileSpecPattern, matchAll } from './regex.js';
import type {
  CheckResult,
  RawSpecPick,
  RawSpecPickObject,
  SpecPick,
  SpecResponse,
} from './types.js';

/** What a pattern can produce for one field. */
export type PickedValue = string | null | Readonly<Record<string, string | null>>;

/** Fills `{param}` placeholders; unknown placeholders are left untouched. */
export function fill(template: string, params: Readonly<Record<string, string>>): string {
  let out = String(template);
  for (const [key, value] of Object.entries(params)) {
    out = out.split(`{${key}}`).join(String(value));
  }
  return out;
}

/** Dot path lookup (`a.b.0.c`), tolerant of missing keys and short arrays. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  let current: unknown = obj;
  for (const part of (path ?? '').split('.')) {
    if (part === '') continue;
    if (Array.isArray(current)) {
      if (/^\d+$/.test(part) && Number(part) < current.length) {
        current = current[Number(part)];
      } else {
        return undefined;
      }
    } else if (current !== null && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * `json_string` unescapes a JSON-escaped value (`\u00e4` → `ä`) — the reason the
 * skill's pitfalls say to prefer it over `unicode_escape`, which is the legacy
 * mojibake path. Deviation from the Python caller (documented): we unescape the
 * standard sequences directly instead of reproducing Python's latin-1 round
 * trip, so we never invent mojibake.
 */
export function decodeValue(value: string | null, decode: string | undefined): string | null {
  if (value === null) return null;
  if (decode === 'json_string') {
    try {
      const parsed: unknown = JSON.parse(`"${value}"`);
      return typeof parsed === 'string' ? parsed : value;
    } catch {
      return value;
    }
  }
  if (decode === 'unicode_escape' || decode === 'unicode') {
    return value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\(["'\\/])/g, '$1');
  }
  return value;
}

/** A bare string in `pick` means "field name = pattern". */
export function normalisePick(pick: RawSpecPick): SpecPick {
  if (typeof pick === 'string') return { name: pick, pattern: pick };
  const object = pick as RawSpecPickObject;
  return {
    name: object.name,
    pattern: object.pattern ?? object.path ?? object.name,
    ...(object.all !== undefined ? { all: object.all } : {}),
    ...(object.dedupe !== undefined ? { dedupe: object.dedupe } : {}),
    ...(object.decode !== undefined ? { decode: object.decode } : {}),
  };
}

function groupValue(match: RegExpExecArray, decode: string | undefined): PickedValue {
  const totalGroups = match.length - 1;
  const named = match.groups ?? {};
  const names = Object.keys(named);
  if (totalGroups > 0 && names.length === totalGroups) {
    const row: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(named)) {
      row[name] = decodeValue(value ?? '', decode);
    }
    return row;
  }
  for (let index = 1; index <= totalGroups; index += 1) {
    const value = match[index];
    if (value !== undefined) return decodeValue(value, decode);
  }
  if (totalGroups === 0) return decodeValue(match[0] ?? '', decode);
  return null;
}

function dedupeOrdered(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = typeof value === 'string' ? `s:${value}` : `j:${JSON.stringify(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Applies one pick to a text segment (shared by HTML and browser-text paths). */
export function pickValue(
  segment: string,
  pick: SpecPick,
  params: Readonly<Record<string, string>>,
): unknown {
  const pattern = fill(pick.pattern, params);
  const re = compileSpecPattern(pattern);
  if (pick.all) {
    const rows = matchAll(re, segment).map((match) => groupValue(match, undefined));
    return pick.dedupe ? dedupeOrdered(rows) : rows;
  }
  const match = re.exec(segment);
  if (!match) return null;
  return groupValue(match, pick.decode);
}

/**
 * `format: html` — the SSR path. With `item_pattern` each match is one row (its
 * named groups seed the row, the picks run INSIDE the segment); without it the
 * picks run over the whole body, truncated at `slice_before` (a plain
 * substring, e.g. to cut off the site's "similar ads" block).
 */
export function extractHtml(
  body: string,
  response: SpecResponse,
  params: Readonly<Record<string, string>>,
): unknown {
  const picks = (response.pick ?? []).map(normalisePick);
  if (response.item_pattern !== undefined) {
    const re = compileSpecPattern(fill(response.item_pattern, params));
    const items: Record<string, unknown>[] = [];
    for (const match of matchAll(re, body)) {
      const row: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(match.groups ?? {})) row[name] = value;
      for (const pick of picks) row[pick.name] = pickValue(match[0], pick, params);
      items.push(row);
    }
    return items;
  }
  let text = body;
  if (response.slice_before !== undefined) {
    const index = text.indexOf(response.slice_before);
    if (index > 0) text = text.slice(0, index);
  }
  const out: Record<string, unknown> = {};
  for (const pick of picks) out[pick.name] = pickValue(text, pick, params);
  return out;
}

/** `format: json` / `embedded-json` — parse, walk `extract`, map `pick` paths. */
export function extractJson(
  body: string,
  response: SpecResponse,
  params: Readonly<Record<string, string>>,
): unknown {
  const source = response.raw ? fill(response.raw, params) : body;
  const parsed: unknown = JSON.parse(source);
  const root = getPath(parsed, response.extract ?? '');
  if (root === null || root === undefined) return null;
  const list = Array.isArray(root) ? root : [root];
  const picks = response.pick ?? [];
  if (picks.length === 0) return list;
  const items: Record<string, unknown>[] = [];
  for (const item of list) {
    const row: Record<string, unknown> = {};
    for (const rawPick of picks) {
      const pick = normalisePick(rawPick);
      const path = typeof rawPick === 'string' ? rawPick : (rawPick.path ?? pick.name);
      const value = getPath(item, path);
      row[pick.name] =
        typeof value === 'string' ? decodeValue(value, pick.decode) : value === undefined ? null : value;
    }
    items.push(row);
  }
  return items.length !== 1 || response.multi ? items : items[0];
}

/**
 * The browser transport's extractor: the same picks applied to the visible text
 * blobs read out of a live tab — one blob per element in list mode, the page
 * body otherwise. Text only: no attributes, no JavaScript, no cookies.
 */
export function extractBrowserText(
  texts: readonly string[],
  response: SpecResponse,
  params: Readonly<Record<string, string>>,
): unknown {
  const picks = (response.pick ?? []).map(normalisePick);
  if (response.item_pattern !== undefined) {
    const rows: Record<string, unknown>[] = [];
    for (const blob of texts) {
      const row: Record<string, unknown> = {};
      for (const pick of picks) row[pick.name] = pickValue(blob, pick, params);
      rows.push(row);
    }
    return rows;
  }
  let blob = texts[0] ?? '';
  if (response.slice_before !== undefined) {
    const index = blob.indexOf(response.slice_before);
    if (index > 0) blob = blob.slice(0, index);
  }
  const out: Record<string, unknown> = {};
  for (const pick of picks) out[pick.name] = pickValue(blob, pick, params);
  return out;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  );
}

/**
 * The `check` contract: validates EVERY extracted row, not just the first — a
 * search page can contain a card whose markup variant the pattern misses, and
 * that must fail the check instead of silently passing on row 0.
 */
export function checkMissing(data: unknown, expect: readonly string[]): CheckResult {
  const rows: Record<string, unknown>[] = Array.isArray(data)
    ? data.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row))
    : data !== null && typeof data === 'object' && !Array.isArray(data)
      ? [data as Record<string, unknown>]
      : [];
  if (rows.length === 0) return { missing: ['<no rows extracted>'], rows: 0 };
  const missing: string[] = [];
  rows.forEach((row, index) => {
    for (const field of expect) {
      if (isEmptyValue(row[field])) missing.push(`${index}:${field}`);
    }
  });
  return { missing, rows: rows.length };
}
