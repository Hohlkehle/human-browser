/**
 * MCP tool schemas (Stage 5) — every tool input and output is described by a
 * Zod schema. The MCP SDK converts them to JSON Schema for `tools/list`, so
 * clients (e.g. MCP Inspector) see the full JSON Schema of each tool, and all
 * arguments are validated by the SDK BEFORE any handler or browser call.
 */
import { z } from 'zod';

/**
 * WAI-ARIA roles accepted by Playwright's `getByRole` (kept in sync with
 * `playwright-core` types; `AriaRoleName` is the compile-time proof).
 */
export const ARIA_ROLES = [
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'meter',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
] as const;

import type { AriaRoleName } from '../browser/locator.js';

/** Compile-time check: the enum above is exactly Playwright's role union. */
type RoleEnumCheck = [(typeof ARIA_ROLES)[number]] extends [AriaRoleName]
  ? [AriaRoleName] extends [(typeof ARIA_ROLES)[number]]
    ? true
    : never
  : never;
const _roleEnumIsComplete: RoleEnumCheck = true;
void _roleEnumIsComplete;

const MAX_MATCH_TEXT_CHARS = 500;
const MAX_SELECTOR_CHARS = 2_000;

/**
 * Locator spec crossing the MCP boundary: role/label/text/CSS only. Engine
 * prefixes (`xpath=`, `text=`, `internal:` ...) cannot be expressed here; the
 * adapter re-validates as defense in depth.
 */
export const locatorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role'),
    role: z.enum(ARIA_ROLES),
    name: z.string().min(1).max(MAX_MATCH_TEXT_CHARS).optional(),
    exact: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('label'),
    label: z.string().min(1).max(MAX_MATCH_TEXT_CHARS),
    exact: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('text'),
    text: z.string().min(1).max(MAX_MATCH_TEXT_CHARS),
    exact: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('css'),
    selector: z.string().min(1).max(MAX_SELECTOR_CHARS),
  }),
]);

export const pageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .describe('Stable internal tab id from page_list (e.g. "page-3"). Never a URL or CDP target id.');

export const urlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .describe('http/https URL on the configured domain allowlist; credentials in URLs are rejected.');

export const timeoutMsSchema = z
  .number()
  .int()
  .min(1)
  .max(300_000)
  .optional()
  .describe('Per-operation timeout override in milliseconds (default from server config).');

export const nthSchema = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('0-based index to pick when the locator matches several elements.');

export const waitUntilSchema = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']);
export const waitForLoadStateSchema = z.enum(['load', 'domcontentloaded', 'networkidle']);
export const waitForStateSchema = z.enum(['attached', 'detached', 'visible', 'hidden']);

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

export const pageOpenInputSchema = z.object({
  url: urlSchema
    .optional()
    .describe('Allowed-domain URL to load in the new tab; omit for about:blank.'),
  timeoutMs: timeoutMsSchema,
});

export const pageNavigateInputSchema = z.object({
  pageId: pageIdSchema,
  url: urlSchema,
  waitUntil: waitUntilSchema.optional(),
  timeoutMs: timeoutMsSchema,
});

export const pageSnapshotInputSchema = z.object({
  pageId: pageIdSchema,
  timeoutMs: timeoutMsSchema,
});

export const pageScreenshotInputSchema = z.object({
  pageId: pageIdSchema,
  fullPage: z
    .boolean()
    .optional()
    .describe('Capture the full scrollable page instead of the viewport.'),
  timeoutMs: timeoutMsSchema,
});

export const pageClickInputSchema = z.object({
  pageId: pageIdSchema,
  locator: locatorSchema,
  nth: nthSchema,
  confirmToken: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Single-use confirmation token from a previous confirmation_required error. REQUIRED for purchases, sending messages and account changes after the user explicitly approved.',
    ),
  timeoutMs: timeoutMsSchema,
});

export const pageFillInputSchema = z.object({
  pageId: pageIdSchema,
  locator: locatorSchema,
  value: z
    .string()
    .max(10_000)
    .describe('Text to type. Never echoed back. Password fields are always refused.'),
  nth: nthSchema,
  timeoutMs: timeoutMsSchema,
});

export const pageSelectInputSchema = z
  .object({
    pageId: pageIdSchema,
    locator: locatorSchema,
    values: z.array(z.string().min(1).max(500)).min(1).max(50).optional(),
    label: z.string().min(1).max(MAX_MATCH_TEXT_CHARS).optional(),
    index: z.number().int().min(0).optional(),
    nth: nthSchema,
    timeoutMs: timeoutMsSchema,
  })
  .refine(
    (value) => value.values !== undefined || value.label !== undefined || value.index !== undefined,
    { message: 'page_select requires one of: values, label, index' },
  );

export const pagePressInputSchema = z.object({
  pageId: pageIdSchema,
  key: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\S+$/, 'key must not contain whitespace')
    .describe('Playwright key name, e.g. "Enter", "Tab", "Control+A".'),
  locator: locatorSchema
    .optional()
    .describe('Focus this element first; omit to press on the page.'),
  nth: nthSchema,
  timeoutMs: timeoutMsSchema,
});

export const pageWaitInputSchema = z
  .object({
    pageId: pageIdSchema,
    locator: locatorSchema.optional(),
    state: waitForStateSchema.optional(),
    loadState: waitForLoadStateSchema.optional(),
    nth: nthSchema,
    timeoutMs: timeoutMsSchema,
  })
  .refine((value) => value.locator !== undefined || value.loadState !== undefined, {
    message: 'page_wait requires either locator or loadState',
  });

export const pageExtractInputSchema = z.object({
  pageId: pageIdSchema,
  locator: locatorSchema.optional().describe('Omit to extract the visible body text of the page.'),
  nth: nthSchema,
  timeoutMs: timeoutMsSchema,
});

export const humanRequiredInputSchema = z.object({
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe('Why a human is needed (CAPTCHA, login, sensitive confirmation).'),
  pageId: pageIdSchema.optional().describe('The tab the human should work in, when known.'),
});

// ---------------------------------------------------------------------------
// Tool output schemas
//
// Every tool advertises ONE object schema that covers both outcomes: the
// success fields (optional, present on success) and an optional `error`
// branch (present on failure, alongside `isError: true`). This is required
// for interoperability: MCP clients (including the official SDK client)
// validate `structuredContent` against the advertised output schema even for
// error results, and the SDK server only accepts object schemas — a Zod
// union would be dropped from `tools/list` and break server-side output
// validation. Errors therefore stay structured JSON on every failure path.
// ---------------------------------------------------------------------------

/** Machine-readable error detail; the shape every failure returns. */
export const toolErrorDetailSchema = z.object({
  code: z
    .string()
    .describe(
      'Stable machine-readable code, e.g. domain_forbidden, sensitive_field_forbidden, human_required, human_timeout, captcha_detected, challenge_still_present, confirmation_required, not_connected, timeout.',
    ),
  message: z.string(),
  retryable: z.boolean().describe('True when retrying after a corrective action may succeed.'),
  pageId: z.string().optional(),
});

/** Standalone error envelope (used in tests and documentation). */
export const toolErrorSchema = z.object({ error: toolErrorDetailSchema });

/**
 * Builds the advertised output schema for a tool from its success shape:
 * all success fields become optional and an optional `error` branch is
 * added, so both success and failure `structuredContent` validate.
 */
export function toolOutputSchema(shape: z.ZodRawShape): z.ZodObject {
  return z.object(shape).partial().extend({ error: toolErrorDetailSchema.optional() });
}

export const pageInfoSchema = z.object({
  pageId: z.string(),
  contextId: z.string(),
  url: z.string(),
  title: z.string(),
});

export const humanControlStateSchema = z.enum([
  'ready',
  'running',
  'human_required',
  'waiting_for_user',
  'resuming',
  'failed',
]);

export const humanControlStatusSchema = z.object({
  state: humanControlStateSchema,
  reason: z.string().optional(),
  pageId: z.string().optional(),
  kind: z.enum(['challenge', 'manual']).optional(),
  hostname: z.string().optional(),
  provider: z.string().optional(),
  pausedAt: z.string().optional(),
  timeoutAt: z.string().optional(),
});

/** Success shape shared by browser_connect / browser_status / human_resume. */
export const adapterStatusShape: z.ZodRawShape = {
  connected: z.boolean(),
  endpoint: z.string().describe('Origin of the CDP endpoint; never contains credentials or paths.'),
  browserVersion: z.string().optional(),
  protocolVersion: z.string().optional(),
  tabs: z.number().int(),
  contexts: z.number().int(),
  runningOperations: z.number().int(),
  queuedOperations: z.number().int(),
  limits: z.object({
    maxTabs: z.number().int(),
    maxConcurrentOperations: z.number().int(),
    maxQueuedOperations: z.number().int(),
    operationTimeoutMs: z.number().int(),
  }),
  humanControl: humanControlStatusSchema,
};

export const adapterStatusSchema = z.object(adapterStatusShape);

export const browserConnectOutputShape: z.ZodRawShape = { ...adapterStatusShape };
export const browserStatusOutputShape: z.ZodRawShape = { ...adapterStatusShape };

export const pageListOutputShape: z.ZodRawShape = {
  pages: z.array(pageInfoSchema),
};

export const pageOpenOutputShape: z.ZodRawShape = {
  pageId: z.string(),
  contextId: z.string(),
  url: z.string(),
  title: z.string(),
};
export const pageNavigateOutputShape: z.ZodRawShape = { ...pageOpenOutputShape };

export const pageSnapshotOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  snapshot: z
    .string()
    .describe('Redacted ARIA snapshot (YAML); sensitive field values are [REDACTED].'),
  truncated: z.boolean(),
};

export const pageScreenshotOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  mimeType: z.literal('image/png'),
  sizeBytes: z.number().int(),
  fullPage: z.boolean(),
};

export const pageClickOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  clicked: z.literal(true),
  confirmToken: z
    .string()
    .optional()
    .describe(
      'Present with a confirmation_required error: single-use token to repeat the click after the user approved.',
    ),
  sensitiveAction: z.enum(['purchase', 'message', 'account_change']).optional(),
  description: z.string().optional(),
};

export const pageFillOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  filled: z.literal(true),
};

export const pageSelectOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  selectedValues: z.array(z.string()),
};

export const pagePressOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  pressed: z.literal(true),
};

export const pageWaitOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  waited: z.literal(true),
};

export const pageExtractOutputShape: z.ZodRawShape = {
  pageId: pageIdSchema,
  url: z.string(),
  title: z.string(),
  items: z.array(z.string()),
  truncated: z.boolean(),
};

export const humanRequiredOutputShape: z.ZodRawShape = {
  paused: z.literal(true),
  state: z.enum(['human_required', 'waiting_for_user', 'resuming', 'failed']),
  reason: z.string(),
  pageId: z.string().optional(),
  hostname: z.string().optional(),
  kind: z.enum(['challenge', 'manual']).optional(),
  timeoutAt: z.string().optional(),
  message: z.string(),
};

export const humanResumeOutputShape: z.ZodRawShape = {
  resumed: z.literal(true),
  state: z.literal('ready'),
  status: adapterStatusSchema,
};

export type LocatorInput = z.infer<typeof locatorSchema>;
export type ToolError = z.infer<typeof toolErrorSchema>;
export type AdapterStatusOutput = z.infer<typeof adapterStatusSchema>;
export type PageInfoOutput = z.infer<typeof pageInfoSchema>;
