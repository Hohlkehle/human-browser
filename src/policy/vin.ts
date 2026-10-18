/**
 * VIN privacy (Stage 9).
 *
 * A VIN identifies a specific vehicle and is personal data in the context of
 * the Partslink24 end-to-end scenario: it may be typed into the site by the
 * automation, but it must NEVER appear complete in logs, reports, or any text
 * handed back to the model. Only the masked form survives: the WMI (first 3
 * characters, identifies the manufacturer) and the serial tail (last 6) stay
 * visible, the middle characters are replaced with `*`.
 *
 * `redactVinsInText` is the log/report guard: every VIN-shaped token in an
 * arbitrary string is replaced by its masked form before the string leaves
 * the scenario module.
 */

/** VIN length is fixed by ISO 3779. */
export const VIN_LENGTH = 17;

/**
 * VIN alphabet: ISO 3779 excludes I, O and Q. Case-insensitive matching;
 * results are normalized to upper case.
 */
export const VIN_CHAR_PATTERN = '[A-HJ-NPR-Za-hj-npr-z0-9]';

/** A standalone VIN-shaped token inside arbitrary text. */
const VIN_IN_TEXT = new RegExp(
  `(?<![A-Za-z0-9])${VIN_CHAR_PATTERN}{${VIN_LENGTH}}(?![A-Za-z0-9])`,
  'g',
);

const STRICT_VIN = new RegExp(`^${VIN_CHAR_PATTERN}{${VIN_LENGTH}}$`);

/** True when the value is a formally valid VIN (17 chars, no I/O/Q). */
export function isVin(value: string): boolean {
  return STRICT_VIN.test(value.trim());
}

/**
 * Masks a VIN for logs and reports: keeps the first 3 and last 6 characters,
 * masks everything in between. Non-VIN input is masked defensively — for
 * values of 8+ characters only the first 3 and last 3 survive, shorter values
 * are masked completely. The result never contains more of the original than
 * the masked VIN form would.
 */
export function maskVin(value: string): string {
  const vin = value.trim().toUpperCase();
  if (vin.length === 0) return '';
  if (vin.length >= VIN_LENGTH) {
    return `${vin.slice(0, 3)}${'*'.repeat(vin.length - 9)}${vin.slice(-6)}`;
  }
  if (vin.length >= 8) {
    return `${vin.slice(0, 3)}${'*'.repeat(vin.length - 6)}${vin.slice(-3)}`;
  }
  return '*'.repeat(vin.length);
}

/**
 * Replaces every VIN-shaped token in the text with its masked form. Used on
 * every message the scenario logs or returns, so a VIN can never leak into
 * logs, tool output, or the final report verbatim.
 */
export function redactVinsInText(text: string): string {
  if (text === '') return text;
  return text.replace(VIN_IN_TEXT, (found) => maskVin(found));
}
