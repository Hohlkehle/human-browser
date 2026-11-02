/**
 * Spec patterns are written for Python's `re` (the `graber-web` skill learned
 * every existing spec with it), so they may contain constructs JavaScript does
 * not have. Translate them instead of forcing every learned spec to be
 * rewritten — and throw on anything that cannot be translated faithfully, so a
 * pattern never silently changes meaning.
 *
 * Supported translations:
 *   - `(?P<name>...)` — Python named group → JS `(?<name>...)`.
 *   - `(?s:...)`, `(?m:...)` — inline flag groups. JS has no inline flags, but
 *     every spec pattern is compiled with the equivalent flag on (see
 *     `compileSpecPattern`), so `(?:...)` is the faithful expansion.
 *
 * Anything else (e.g. `(?i:...)` or bare `(?i)`) throws rather than silently
 * matching something else.
 */

/** Inline flag group: `(?flags:`. Lookbehinds (`(?<=`, `(?<!`) never match. */
const INLINE_FLAG_GROUP = /\(\?([a-z]*):/g;

/**
 * Python's absolute anchors: `\Z` (end of input) and `\A` (start of input).
 * JavaScript has no such escapes — leaving them in place makes the engine
 * match a literal "Z"/"A", which silently drops the LAST item of a list-mode
 * pattern (`…(?=<article|\Z)`). Patterns are compiled without the `m` flag, so
 * `$`/`^` are exactly Python's absolute anchors.
 */
const ABSOLUTE_ANCHOR = /(^|[^\\])\\([AZ])/g;

export class SpecPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecPatternError';
  }
}

export function translatePattern(pattern: string): string {
  const withNamedGroups = pattern.replace(/\(\?P</g, '(?<');
  const withAnchors = withNamedGroups.replace(
    ABSOLUTE_ANCHOR,
    (_whole: string, prefix: string, letter: string) => `${prefix}${letter === 'Z' ? '$' : '^'}`,
  );
  return withAnchors.replace(INLINE_FLAG_GROUP, (whole: string, flags: string) => {
    if (flags === '') return '(?:'; // plain non-capturing group: already JS
    if (!/^[sm]+$/.test(flags)) {
      throw new SpecPatternError(
        `unsupported inline flag group "${whole}" in a spec pattern: JavaScript regexes have no inline flags, and dropping them would change the match`,
      );
    }
    return '(?:';
  });
}

/**
 * Compiles a spec pattern with Python's `re.S` semantics: every spec regex ran
 * with DOTALL in the Python caller, so `.` must match newlines here too.
 */
export function compileSpecPattern(pattern: string): RegExp {
  try {
    return new RegExp(translatePattern(pattern), 's');
  } catch (error) {
    if (error instanceof SpecPatternError) throw error;
    throw new SpecPatternError(
      `invalid spec pattern ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * All matches, like Python's `re.findall` / `finditer`: a fresh global regex
 * every call (spec patterns are not sticky) with a zero-length-match guard so
 * an empty match cannot spin forever.
 */
export function matchAll(re: RegExp, text: string): RegExpExecArray[] {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) !== null) {
    matches.push(match);
    if (match.index === global.lastIndex) global.lastIndex += 1;
  }
  return matches;
}
