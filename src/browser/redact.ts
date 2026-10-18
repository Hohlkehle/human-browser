/**
 * Redaction of sensitive field values in Playwright ARIA snapshots.
 *
 * `page.ariaSnapshot()` renders input values verbatim, e.g.
 * `- textbox "Password": hunter2`. Before a snapshot leaves the adapter,
 * every value carried by a value-bearing role (textbox, searchbox, combobox,
 * spinbutton) is masked when:
 *
 * - the accessible name matches a sensitive-field pattern (password, card
 *   number, otp, ...), or
 * - the field has NO accessible name at all: an unnamed textbox may be an
 *   unlabeled password field, and security-first means masking it.
 *
 * Plain text nodes and non-value roles are untouched: the model is allowed to
 * see visible page text, just not what was typed into sensitive fields.
 */

export const REDACTED = '[REDACTED]';

/**
 * Accessible-name patterns that mark a field as sensitive. Deliberately broad:
 * false positives hide a value the model could do without, a false negative
 * leaks a secret from the user's real signed-in session.
 */
export const SENSITIVE_FIELD_NAME_PATTERN =
  /(passw|passcode|парол|secret|token|api[-_ ]?key|auth(?!or\b)|credential|cvv|cvc|card[-_ ]?num|credit[-_ ]?card|debit[-_ ]?card|bank[-_ ]?account|iban|ssn|social[-_ ]?security|otp|one[-_ ]?time|verification[-_ ]?code|confirmation[-_ ]?code|\bpin\b|private[-_ ]?key|mnemonic|seed[-_ ]?phrase|recovery[-_ ]?(code|phrase))/i;

/** ARIA roles whose YAML node value is user-entered input. */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * One YAML node line of an ARIA snapshot:
 * `- role "name" [attr] [attr2]: value` where name, attrs and value are
 * optional (`- text: ...`, `- button "Submit"`, `- textbox: value`).
 */
const SNAPSHOT_NODE_PATTERN =
  /^(?<prefix>\s*-\s)(?<role>[a-zA-Z][\w-]*)(?<name>\s+"(?:[^"\\]|\\.)*")?(?<attrs>(?:\s+\[[^\]]*\])*)(?<tail>:.*)?$/;

const NODE_NAME_PATTERN = /"((?:[^"\\]|\\.)*)"/;

function extractName(namePart: string | undefined): string | undefined {
  if (!namePart) return undefined;
  const match = NODE_NAME_PATTERN.exec(namePart);
  return match ? (match[1] as string) : undefined;
}

/**
 * Masks sensitive field values in an ARIA snapshot. Pure and line-based: the
 * YAML structure (indentation, roles, names, attributes) is preserved so
 * downstream consumers keep working; only the value after the colon is
 * replaced with `[REDACTED]`.
 */
export function redactAriaSnapshot(snapshot: string): string {
  if (snapshot === '') return snapshot;
  const lines = snapshot.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    const node = SNAPSHOT_NODE_PATTERN.exec(line);
    if (!node || !node.groups) continue;

    const role = node.groups['role'] as string;
    if (!VALUE_ROLES.has(role)) continue;

    const tail = node.groups['tail'];
    // No `: value` suffix means there is nothing typed into the field.
    if (!tail || tail === ':') continue;
    const value = tail.slice(1).trimStart();
    if (value === '' || value === REDACTED) continue;

    const name = extractName(node.groups['name']);
    // Named fields are masked only when sensitive; a field with NO accessible
    // name is masked conservatively (it may be an unlabeled password input).
    if (name !== undefined && !SENSITIVE_FIELD_NAME_PATTERN.test(name)) continue;

    const rebuilt = `${node.groups['prefix']}${role}${node.groups['name'] ?? ''}${node.groups['attrs'] ?? ''}: ${REDACTED}`;
    lines[index] = rebuilt;
  }
  return lines.join('\n');
}

/** True when an HTML input `type`/`autocomplete` pair marks a password field. */
export function isPasswordField(type: string | null, autocomplete: string | null): boolean {
  if (type && type.trim().toLowerCase() === 'password') return true;
  if (autocomplete && /current-password|new-password/i.test(autocomplete)) return true;
  return false;
}
