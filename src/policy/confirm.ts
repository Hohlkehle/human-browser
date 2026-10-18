/**
 * Sensitive-action confirmation policy (Stage 6).
 *
 * Purchases, sending messages, and account changes require a SEPARATE,
 * explicit confirmation before the click reaches the browser:
 *
 * 1. `classifySensitiveAction` matches the target's accessible name/visible
 *    text against curated EN/RU/DE keyword lists (heuristic, like the rest of
 *    Stage 6 detection — false positives only add a confirmation step).
 * 2. The tool refuses the click with `confirmation_required` and issues a
 *    single-use, short-lived token bound to (pageId, category).
 * 3. The model must obtain the user's explicit consent and repeat the call
 *    with the token; only then the click is executed.
 *
 * Tokens are random 128-bit values, never derived from page content.
 */
import { randomBytes } from 'node:crypto';

export type SensitiveActionKind = 'purchase' | 'message' | 'account_change';

export const MAX_SENSITIVE_DESCRIPTION_CHARS = 150;
export const DEFAULT_CONFIRMATION_TTL_MS = 300_000;
export const MAX_PENDING_CONFIRMATIONS = 100;

interface KeywordList {
  readonly kind: SensitiveActionKind;
  readonly phrases: readonly string[];
}

/**
 * Curated commit-action keywords. Checked in the order account_change →
 * purchase → message so "change payment method" classifies as an account
 * change, not a purchase.
 */
const KEYWORDS: readonly KeywordList[] = [
  {
    kind: 'account_change',
    phrases: [
      'delete account',
      'close account',
      'deactivate account',
      'disable account',
      'remove account',
      'cancel account',
      'change password',
      'reset password',
      'change email',
      'change e-mail',
      'change phone',
      'change payment',
      'удалить аккаунт',
      'удалить профиль',
      'закрыть аккаунт',
      'отключить аккаунт',
      'сменить пароль',
      'изменить пароль',
      'изменить email',
      'изменить e-mail',
      'konto löschen',
      'konto schließen',
      'konto deaktivieren',
      'passwort ändern',
      'e-mail ändern',
      'email ändern',
    ],
  },
  {
    kind: 'purchase',
    phrases: [
      'buy now',
      'buy',
      'purchase',
      'checkout',
      'check out',
      'place order',
      'order now',
      'complete order',
      'complete purchase',
      'confirm order',
      'submit order',
      'pay now',
      'pay',
      'payment',
      'купить',
      'покупка',
      'оплатить',
      'оплата',
      'оформить заказ',
      'подтвердить заказ',
      'перейти к оплате',
      'kaufen',
      'bestellen',
      'bestellung abschließen',
      'bezahlen',
      'zahlungspflichtig bestellen',
    ],
  },
  {
    kind: 'message',
    phrases: [
      'send message',
      'send a message',
      'post message',
      'post reply',
      'send',
      'senden',
      'nachricht senden',
      'mitteilung senden',
      'отправить сообщение',
      'написать сообщение',
      'отправить',
    ],
  },
];

/** Precompiled word-boundary regexes; boundaries work for Cyrillic too. */
const COMPILED: readonly { kind: SensitiveActionKind; pattern: RegExp }[] = KEYWORDS.map(
  ({ kind, phrases }) => {
    const escaped = phrases.map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(?<![a-zа-яё0-9_])(?:${escaped.join('|')})(?![a-zа-яё0-9_])`, 'i');
    return { kind, pattern };
  },
);

/**
 * Classifies an element description (accessible name / visible text) as a
 * sensitive commit action, or undefined when nothing matches.
 */
export function classifySensitiveAction(text: string): SensitiveActionKind | undefined {
  const haystack = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (haystack.length === 0) return undefined;
  for (const { kind, pattern } of COMPILED) {
    if (pattern.test(haystack)) return kind;
  }
  return undefined;
}

/** Human-readable category label for confirmations and logs. */
export function sensitiveActionLabel(kind: SensitiveActionKind): string {
  switch (kind) {
    case 'purchase':
      return 'purchase/payment';
    case 'message':
      return 'sending a message';
    case 'account_change':
      return 'account change';
  }
}

export interface ConfirmationRequest {
  readonly pageId: string;
  readonly kind: SensitiveActionKind;
  /** Element description shown to the user; capped, visible text only. */
  readonly description: string;
}

export interface ConfirmationGateOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export interface ConfirmationGate {
  /** Issues a single-use token bound to (pageId, kind). */
  request(params: ConfirmationRequest): string;
  /** Consumes the token when it matches; single-use, TTL-bounded. */
  consume(token: string, pageId: string, kind: SensitiveActionKind): boolean;
  /** Number of live (non-expired) pending confirmations. */
  pendingCount(): number;
}

interface PendingConfirmation {
  readonly pageId: string;
  readonly kind: SensitiveActionKind;
  readonly description: string;
  readonly expiresAt: number;
}

export function createConfirmationGate(options: ConfirmationGateOptions = {}): ConfirmationGate {
  const ttlMs = options.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('confirmation gate ttlMs must be a positive number');
  }
  const now = options.now ?? Date.now;
  const pending = new Map<string, PendingConfirmation>();

  function prune(): void {
    const current = now();
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= current) pending.delete(token);
    }
  }

  return {
    request(params) {
      prune();
      if (pending.size >= MAX_PENDING_CONFIRMATIONS) {
        // Bounded memory: drop the oldest entry (Map keeps insertion order).
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      const token = randomBytes(16).toString('hex');
      pending.set(token, {
        pageId: params.pageId,
        kind: params.kind,
        description: params.description.slice(0, MAX_SENSITIVE_DESCRIPTION_CHARS),
        expiresAt: now() + ttlMs,
      });
      return token;
    },

    consume(token, pageId, kind) {
      if (typeof token !== 'string' || token.length === 0) return false;
      const entry = pending.get(token);
      if (!entry) return false;
      // Single-use regardless of freshness; only a full match executes.
      pending.delete(token);
      return entry.expiresAt > now() && entry.pageId === pageId && entry.kind === kind;
    },

    pendingCount() {
      prune();
      return pending.size;
    },
  };
}
