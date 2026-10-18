/**
 * Stage 9: VIN masking. A VIN must never appear complete in logs, reports or
 * model-facing text — only the masked form (WMI + serial tail) survives.
 */
import { describe, expect, it } from 'vitest';
import { isVin, maskVin, redactVinsInText, VIN_LENGTH } from '../../src/policy/vin.js';

const VIN = 'WVWZZZ1KZAW123456';

describe('isVin', () => {
  it('accepts a formally valid VIN', () => {
    expect(isVin(VIN)).toBe(true);
    expect(isVin(` ${VIN.toLowerCase()} `)).toBe(true);
  });

  it('rejects wrong lengths and the excluded letters I, O, Q', () => {
    expect(isVin(VIN.slice(0, 16))).toBe(false);
    expect(isVin(`${VIN}A`)).toBe(false);
    expect(isVin('WVWZZZ1KZAW12345I')).toBe(false);
    expect(isVin('WVWZZZ1KZAW12345O')).toBe(false);
    expect(isVin('WVWZZZ1KZAW12345Q')).toBe(false);
    expect(isVin('')).toBe(false);
  });
});

describe('maskVin', () => {
  it('keeps the WMI and the serial tail, masks the middle', () => {
    expect(maskVin(VIN)).toBe('WVW********123456');
    // The masked form keeps its length and never carries the middle chars.
    expect(maskVin(VIN)).toHaveLength(VIN_LENGTH);
    expect(maskVin(VIN)).not.toContain('ZZZ1KZAW');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(maskVin(` ${VIN.toLowerCase()} `)).toBe('WVW********123456');
  });

  it('masks short or non-VIN input defensively', () => {
    expect(maskVin('AB123')).toBe('*****');
    expect(maskVin('ABCD1234')).toBe('ABC**234');
    expect(maskVin('')).toBe('');
  });
});

describe('redactVinsInText', () => {
  it('masks every VIN-shaped token in arbitrary text', () => {
    const text = `search vin=${VIN} and also ${VIN.toLowerCase()} done`;
    const redacted = redactVinsInText(text);
    expect(redacted).toBe('search vin=WVW********123456 and also WVW********123456 done');
    expect(redacted).not.toContain(VIN);
  });

  it('leaves non-VIN tokens untouched', () => {
    const text = 'part 06K103271B fits Golf VI (short WVW123)';
    expect(redactVinsInText(text)).toBe(text);
  });

  it('does not match inside longer alphanumeric runs', () => {
    const longer = `X${VIN}Y`;
    expect(redactVinsInText(longer)).toBe(longer);
  });

  it('returns empty text unchanged', () => {
    expect(redactVinsInText('')).toBe('');
  });
});
