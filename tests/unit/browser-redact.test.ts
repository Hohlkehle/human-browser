import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  SENSITIVE_FIELD_NAME_PATTERN,
  isPasswordField,
  redactAriaSnapshot,
} from '../../src/browser/redact.js';

describe('redactAriaSnapshot', () => {
  it('masks values of sensitive-named textboxes and keeps everything else', () => {
    const snapshot = [
      '- heading "Form" [level=1]',
      '- text: Username',
      '- textbox "Username": john_doe',
      '- text: Password',
      '- textbox "Password": hunter2secret',
      '- textbox "Card number": 4111 1111 1111 1111',
      '- combobox "Country":',
      '  - option "DE"',
      '  - option "US" [selected]',
      '- button "Submit"',
      '- list:',
      '  - listitem: alpha',
    ].join('\n');

    const redacted = redactAriaSnapshot(snapshot);

    expect(redacted).toContain(`- textbox "Username": john_doe`);
    expect(redacted).toContain(`- textbox "Password": ${REDACTED}`);
    expect(redacted).toContain(`- textbox "Card number": ${REDACTED}`);
    expect(redacted).not.toContain('hunter2secret');
    expect(redacted).not.toContain('4111');
    // Structure and non-sensitive content survive untouched.
    expect(redacted).toContain('- heading "Form" [level=1]');
    expect(redacted).toContain('  - option "US" [selected]');
    expect(redacted).toContain('  - listitem: alpha');
  });

  it('masks unnamed value-bearing fields conservatively', () => {
    const snapshot = ['- textbox: typed-secret', '- searchbox: visible query'].join('\n');
    const redacted = redactAriaSnapshot(snapshot);
    expect(redacted).toContain(`- textbox: ${REDACTED}`);
    expect(redacted).toContain(`- searchbox: ${REDACTED}`);
    expect(redacted).not.toContain('typed-secret');
    expect(redacted).not.toContain('visible query');
  });

  it('leaves empty values and already-redacted values untouched', () => {
    const snapshot = ['- textbox "Password":', `- textbox "OTP": ${REDACTED}`].join('\n');
    expect(redactAriaSnapshot(snapshot)).toBe(snapshot);
  });

  it('matches sensitive names case-insensitively and in Russian', () => {
    const snapshot = [
      '- textbox "PASSWORD": abc',
      '- textbox "Пароль": abc',
      '- textbox "Current Password": abc',
      '- textbox "API key": abc',
      '- textbox "Verification Code": abc',
      '- textbox "PIN": abc',
      '- textbox "CVV": abc',
    ].join('\n');
    const redacted = redactAriaSnapshot(snapshot);
    expect(redacted).not.toContain('abc');
  });

  it('does not over-redact names that merely contain "auth" as a substring', () => {
    expect(SENSITIVE_FIELD_NAME_PATTERN.test('Author name')).toBe(false);
    expect(SENSITIVE_FIELD_NAME_PATTERN.test('Authorization code')).toBe(true);
    // "spin" contains "pin" but is not a PIN field.
    expect(SENSITIVE_FIELD_NAME_PATTERN.test('spinning wheel')).toBe(false);
    expect(SENSITIVE_FIELD_NAME_PATTERN.test('PIN code')).toBe(true);
  });

  it('keeps attribute decorations when masking', () => {
    const snapshot = '- textbox "Password" [multiline]: abc';
    expect(redactAriaSnapshot(snapshot)).toBe(`- textbox "Password" [multiline]: ${REDACTED}`);
  });

  it('returns empty input unchanged', () => {
    expect(redactAriaSnapshot('')).toBe('');
  });
});

describe('isPasswordField', () => {
  it('detects type=password in any case', () => {
    expect(isPasswordField('password', null)).toBe(true);
    expect(isPasswordField(' PASSWORD ', null)).toBe(true);
    expect(isPasswordField('text', null)).toBe(false);
    expect(isPasswordField(null, null)).toBe(false);
  });

  it('detects password autocomplete values', () => {
    expect(isPasswordField('text', 'current-password')).toBe(true);
    expect(isPasswordField(null, 'new-password')).toBe(true);
    expect(isPasswordField(null, 'username')).toBe(false);
  });
});
