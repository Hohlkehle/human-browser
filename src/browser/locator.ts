/**
 * Locator model for the browser adapter: role, label, text and CSS only.
 *
 * Specs are plain validated data (safe to cross the MCP boundary); resolution
 * to a Playwright `Locator` happens inside the adapter. No other selector
 * engines are permitted.
 */
import type { Locator, Page } from 'playwright-core';

/** Union of ARIA roles accepted by `page.getByRole`, taken from Playwright. */
export type AriaRoleName = Parameters<Page['getByRole']>[0];

export type LocatorSpec =
  | {
      readonly kind: 'role';
      readonly role: AriaRoleName;
      readonly name?: string;
      readonly exact?: boolean;
    }
  | { readonly kind: 'label'; readonly label: string; readonly exact?: boolean }
  | { readonly kind: 'text'; readonly text: string; readonly exact?: boolean }
  | { readonly kind: 'css'; readonly selector: string };

export class LocatorSpecError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LocatorSpecError';
  }
}

export const MAX_MATCH_TEXT_CHARS = 500;
export const MAX_SELECTOR_CHARS = 2_000;

const LOCATOR_KINDS = new Set(['role', 'label', 'text', 'css']);

/**
 * Playwright selector-engine prefixes. Only the default CSS engine is allowed,
 * so a spec can never smuggle in `xpath=`, `text=`, `id=`, `internal:*`, etc.
 * The generic form is `engine=` (an identifier followed by `=`); it cannot be
 * broadened to `:` because valid CSS pseudo-classes use `:` (e.g. `div:hover`),
 * so the `internal:` family is rejected explicitly below.
 */
const ENGINE_PREFIX_PATTERN = /^([a-z][a-z0-9-]*)=/i;
const INTERNAL_SELECTOR_PATTERN = /^internal:/i;

function assertBoundedText(kind: string, value: string, maxChars: number): void {
  if (value.length === 0) {
    throw new LocatorSpecError(`${kind} must not be empty`);
  }
  if (value.length > maxChars) {
    throw new LocatorSpecError(`${kind} exceeds ${maxChars} characters`);
  }
}

/** Validates a locator spec; throws `LocatorSpecError` on any problem. */
export function validateLocatorSpec(spec: LocatorSpec): void {
  if (!spec || typeof spec !== 'object' || !LOCATOR_KINDS.has(spec.kind)) {
    throw new LocatorSpecError('locator kind must be one of: role, label, text, css');
  }
  switch (spec.kind) {
    case 'role': {
      assertBoundedText('role', String(spec.role), 64);
      if (spec.name !== undefined) assertBoundedText('role name', spec.name, MAX_MATCH_TEXT_CHARS);
      return;
    }
    case 'label': {
      assertBoundedText('label', spec.label, MAX_MATCH_TEXT_CHARS);
      return;
    }
    case 'text': {
      assertBoundedText('text', spec.text, MAX_MATCH_TEXT_CHARS);
      return;
    }
    case 'css': {
      assertBoundedText('selector', spec.selector, MAX_SELECTOR_CHARS);
      const trimmed = spec.selector.trimStart();
      const engine = ENGINE_PREFIX_PATTERN.exec(trimmed);
      if (engine && (engine[1] as string).toLowerCase() !== 'css') {
        throw new LocatorSpecError(
          `selector engine "${engine[1]}=" is not allowed; only CSS selectors are supported`,
        );
      }
      if (INTERNAL_SELECTOR_PATTERN.test(trimmed)) {
        throw new LocatorSpecError(
          'internal: selectors are not allowed; only CSS selectors are supported',
        );
      }
      return;
    }
  }
}

/**
 * Builds a strict-mode Playwright locator from a validated spec. `nth`
 * disambiguates multi-match locators (0-based).
 */
export function resolveLocator(page: Page, spec: LocatorSpec, nth?: number): Locator {
  validateLocatorSpec(spec);
  if (nth !== undefined && (!Number.isInteger(nth) || nth < 0)) {
    throw new LocatorSpecError('nth must be a non-negative integer');
  }

  let locator: Locator;
  try {
    switch (spec.kind) {
      case 'role': {
        const options: { name?: string; exact?: boolean } = {};
        if (spec.name !== undefined) options.name = spec.name;
        if (spec.exact === true) options.exact = true;
        locator = page.getByRole(spec.role, options);
        break;
      }
      case 'label': {
        locator = page.getByLabel(spec.label, spec.exact === true ? { exact: true } : {});
        break;
      }
      case 'text': {
        locator = page.getByText(spec.text, spec.exact === true ? { exact: true } : {});
        break;
      }
      case 'css': {
        locator = page.locator(spec.selector);
        break;
      }
    }
  } catch (cause) {
    throw new LocatorSpecError(
      `Unable to build locator from ${spec.kind} spec: ${(cause as Error).message}`,
      { cause },
    );
  }
  return nth === undefined ? locator : locator.nth(nth);
}
