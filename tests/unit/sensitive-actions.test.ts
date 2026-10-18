/**
 * Stage 6 unit tests: sensitive-action classification and the single-use
 * confirmation gate (purchases, messages, account changes).
 */
import { describe, expect, it } from 'vitest';
import {
  classifySensitiveAction,
  createConfirmationGate,
  sensitiveActionLabel,
} from '../../src/policy/confirm.js';

describe('classifySensitiveAction', () => {
  const purchases = [
    'Buy now',
    'buy',
    'Purchase',
    'Proceed to Checkout',
    'Place order',
    'Pay now',
    'Complete purchase',
    'Купить',
    'Оплатить заказ',
    'Оформить заказ',
    'Jetzt kaufen',
    'Bestellung abschließen',
    'Zahlungspflichtig bestellen',
  ];
  for (const text of purchases) {
    it(`classifies "${text}" as purchase`, () => {
      expect(classifySensitiveAction(text)).toBe('purchase');
    });
  }

  const messages = [
    'Send message',
    'Send',
    'Post reply',
    'Senden',
    'Nachricht senden',
    'Отправить сообщение',
    'Отправить',
  ];
  for (const text of messages) {
    it(`classifies "${text}" as message`, () => {
      expect(classifySensitiveAction(text)).toBe('message');
    });
  }

  const account = [
    'Delete account',
    'Change password',
    'Change e-mail',
    'Deactivate account',
    'Удалить аккаунт',
    'Сменить пароль',
    'Konto löschen',
    'Passwort ändern',
  ];
  for (const text of account) {
    it(`classifies "${text}" as account_change`, () => {
      expect(classifySensitiveAction(text)).toBe('account_change');
    });
  }

  it('account_change wins over purchase ("change payment method")', () => {
    expect(classifySensitiveAction('Change payment method')).toBe('account_change');
  });

  const harmless = [
    'Cancel',
    'Add to cart',
    'Search parts',
    'Next page',
    'Buyer protection info', // "buy" must not match inside "buyer"
    'Busy loading spinner',
    'Purchases history overview', // "purchase" must not match inside "purchases"
    'Sendung verfolgen', // "senden" must not match inside "sendung"
    '',
    '   ',
  ];
  for (const text of harmless) {
    it(`does not classify "${text}"`, () => {
      expect(classifySensitiveAction(text)).toBeUndefined();
    });
  }

  it('labels categories for humans', () => {
    expect(sensitiveActionLabel('purchase')).toBe('purchase/payment');
    expect(sensitiveActionLabel('message')).toBe('sending a message');
    expect(sensitiveActionLabel('account_change')).toBe('account change');
  });
});

describe('createConfirmationGate', () => {
  it('issues a token that is consumed exactly once on a full match', () => {
    const gate = createConfirmationGate();
    const token = gate.request({ pageId: 'page-1', kind: 'purchase', description: 'Buy now' });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(gate.consume(token, 'page-1', 'purchase')).toBe(true);
    // Single-use.
    expect(gate.consume(token, 'page-1', 'purchase')).toBe(false);
  });

  it('rejects tokens for a different page or category', () => {
    const gate = createConfirmationGate();
    const token = gate.request({ pageId: 'page-1', kind: 'purchase', description: 'Buy' });
    expect(gate.consume(token, 'page-2', 'purchase')).toBe(false);
    const token2 = gate.request({ pageId: 'page-1', kind: 'message', description: 'Send' });
    expect(gate.consume(token2, 'page-1', 'purchase')).toBe(false);
  });

  it('rejects unknown or empty tokens', () => {
    const gate = createConfirmationGate();
    expect(gate.consume('nope', 'page-1', 'purchase')).toBe(false);
    expect(gate.consume('', 'page-1', 'purchase')).toBe(false);
  });

  it('expires tokens after the TTL', () => {
    let current = 1_000_000;
    const gate = createConfirmationGate({ ttlMs: 500, now: () => current });
    const token = gate.request({ pageId: 'page-1', kind: 'purchase', description: 'Buy' });
    current += 499;
    expect(gate.consume(token, 'page-1', 'purchase')).toBe(true);

    const token2 = gate.request({ pageId: 'page-1', kind: 'purchase', description: 'Buy' });
    current += 501;
    expect(gate.consume(token2, 'page-1', 'purchase')).toBe(false);
  });

  it('pendingCount prunes expired entries', () => {
    let current = 1_000_000;
    const gate = createConfirmationGate({ ttlMs: 100, now: () => current });
    gate.request({ pageId: 'page-1', kind: 'purchase', description: 'Buy' });
    gate.request({ pageId: 'page-1', kind: 'message', description: 'Send' });
    expect(gate.pendingCount()).toBe(2);
    current += 200;
    expect(gate.pendingCount()).toBe(0);
  });

  it('bounds the number of pending confirmations', () => {
    const gate = createConfirmationGate();
    for (let i = 0; i < 120; i += 1) {
      gate.request({ pageId: 'page-1', kind: 'purchase', description: `Buy ${i}` });
    }
    expect(gate.pendingCount()).toBeLessThanOrEqual(100);
  });

  it('rejects a non-positive TTL', () => {
    expect(() => createConfirmationGate({ ttlMs: 0 })).toThrowError(/ttlMs/);
  });
});
