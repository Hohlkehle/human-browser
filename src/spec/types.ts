/**
 * Types for learned site specs (the `graber-web` skill's format, unchanged).
 *
 * A spec is one JSON file per site: a URL/target plus a set of regex "picks"
 * that turn a response — a raw HTTP body or the visible text of a tab driven
 * through this same MCP server — into structured rows. The format is
 * documented for humans in `docs/site-specs.md`.
 *
 * Field names stay snake_case on purpose: the same JSON files are read by the
 * Python caller shipped with the skill, so the wire format must not shift.
 */

export type SpecDecode = 'json_string' | 'unicode_escape' | 'unicode';

export interface SpecPick {
  readonly name: string;
  readonly pattern: string;
  readonly all?: boolean;
  readonly dedupe?: boolean;
  readonly decode?: SpecDecode;
}

/** A pick as written in the spec: a bare pattern string means "name = pattern". */
export type RawSpecPick = string | RawSpecPickObject;

export interface RawSpecPickObject {
  readonly name: string;
  readonly pattern?: string;
  readonly path?: string;
  readonly all?: boolean;
  readonly dedupe?: boolean;
  readonly decode?: SpecDecode;
}

export interface SpecResponse {
  /** Informational for the browser transport; the picks are the same. */
  readonly format?: 'json' | 'embedded-json' | 'html' | 'browser-text';
  /** Template parsed instead of the response body (rare). */
  readonly raw?: string;
  /** Dot path to the items (json / embedded-json). */
  readonly extract?: string;
  readonly pick?: readonly RawSpecPick[];
  /** Keep a single item as a list instead of unwrapping it. */
  readonly multi?: boolean;
  /** HTML list mode: each match becomes a row. */
  readonly item_pattern?: string;
  /** Plain substring that truncates the body before the picks run. */
  readonly slice_before?: string;
}

export interface SpecParam {
  readonly name: string;
  readonly example?: string;
  readonly hint?: string;
}

export interface SpecCheck {
  /** Holdout params (a different real value than the learning args). */
  readonly params?: Readonly<Record<string, string>>;
  /** Fields that must be non-empty in EVERY extracted row. */
  readonly expect?: readonly string[];
}

export interface SpecOp {
  readonly description?: string;
  /** Omitted or "http" = plain HTTP; "browser-mcp" = drive the visible Chrome. */
  readonly transport?: 'http' | 'browser-mcp';
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | null;
  readonly timeout?: number;
  readonly retries?: number;
  readonly retry_wait?: number;
  /** Path to a local file holding the Cookie header value; never the value. */
  readonly cookies_file?: string;
  readonly params?: readonly SpecParam[];
  readonly response?: SpecResponse;
  // --- browser transport only -------------------------------------------------
  /** URL substring of the tab this op may reuse; never the user's own tab. */
  readonly tab_match?: string;
  readonly tab_match_url?: string;
  readonly wait_selector?: string;
  readonly wait_timeout_ms?: number;
  /** List mode: one text blob per matching element. */
  readonly item_selector?: string;
  /** Single-object mode source (default `body`). */
  readonly text_selector?: string;
  readonly settle?: number;
  readonly check?: SpecCheck;
}

export interface SiteSpec {
  readonly name: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly description?: string;
  readonly learned_at?: string;
  readonly learned_by?: string;
  readonly ops: Readonly<Record<string, SpecOp>>;
}

/** One extracted row: named fields, values are whatever the pattern produced. */
export type SpecRow = Record<string, unknown>;

export interface OpResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly ms: number;
  /** List (row-mode ops) or a single object (single-object ops). */
  readonly data: unknown;
  readonly error: string | null;
}

export interface CheckResult {
  /** Rows that have at least one empty expected field, as "rowIndex:field". */
  readonly missing: readonly string[];
  readonly rows: number;
}
