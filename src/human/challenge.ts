/**
 * Probable-CAPTCHA detection (Stage 6).
 *
 * Pure classification of page signals (main URL, frame/iframe URLs, visible
 * text) into "a human challenge is probably on screen". Detection is a
 * heuristic on purpose: a false positive only pauses automation (the safe
 * direction), while a CAPTCHA is NEVER solved automatically — on detection
 * the tools stop, keep the tab visible, and hand control to the user.
 *
 * The raw signals (especially `visibleText`) are server-internal only: the
 * result carries a provider name, the matched signal kind, and a safe
 * explanation, never page content.
 */

export type ChallengeProvider =
  'recaptcha' | 'hcaptcha' | 'turnstile' | 'geetest' | 'arkose' | 'yandex' | 'generic';

/** Which signal raised the detection. */
export type ChallengeSignalKind = 'url' | 'iframe' | 'text';

export interface ChallengeSignals {
  /** Main frame URL of the tab. */
  readonly url: string;
  /** URLs of all frames (main frame included). */
  readonly frameUrls?: readonly string[];
  /** Visible body text, whitespace-normalized and capped by the adapter. */
  readonly visibleText?: string;
}

export type ChallengeDetection =
  | {
      readonly detected: true;
      readonly provider: ChallengeProvider;
      readonly signal: ChallengeSignalKind;
    }
  | { readonly detected: false };

/** Cap on how much visible text is scanned (defense against huge pages). */
export const MAX_CHALLENGE_TEXT_SCAN_CHARS = 8_000;

interface HostRule {
  readonly provider: ChallengeProvider;
  /** Matched against `hostname === h || hostname.endsWith('.' + h)`. */
  readonly hosts: readonly string[];
  /** Substrings matched against `hostname + pathname` (lower-cased). */
  readonly pathNeedles?: readonly string[];
}

/** Known challenge providers and how their frames/URLs look. */
const HOST_RULES: readonly HostRule[] = [
  {
    provider: 'recaptcha',
    hosts: ['recaptcha.net', 'recaptcha.google.com'],
    pathNeedles: ['/recaptcha', 'recaptcha/api', 'recaptchaenterprise'],
  },
  {
    provider: 'recaptcha',
    hosts: [],
    pathNeedles: ['google.com/recaptcha', 'gstatic.com/recaptcha'],
  },
  {
    provider: 'hcaptcha',
    hosts: ['hcaptcha.com'],
    pathNeedles: ['hcaptcha.com'],
  },
  {
    provider: 'turnstile',
    hosts: ['challenges.cloudflare.com'],
    pathNeedles: ['challenges.cloudflare.com', 'turnstile'],
  },
  {
    provider: 'geetest',
    hosts: ['geetest.com'],
    pathNeedles: ['geetest', 'gt_captcha'],
  },
  {
    provider: 'arkose',
    hosts: ['arkoselabs.com', 'funcaptcha.com', 'captcha.ai'],
    pathNeedles: ['funcaptcha', 'arkoselabs', 'arkose'],
  },
  {
    provider: 'yandex',
    hosts: [
      'smartcaptcha.yandexcloud.net',
      'check.smartcaptcha.yandexcloud.net',
      'captcha.yandex.ru',
    ],
    pathNeedles: ['smartcaptcha'],
  },
];

/**
 * Path needles for the MAIN page URL (site-level antibot/interstitial pages).
 * Deliberately conservative: bare "challenge" is too broad, Cloudflare's
 * interstitial paths and explicit captcha/antibot markers are not.
 */
const MAIN_URL_NEEDLES: readonly { needle: string; provider: ChallengeProvider }[] = [
  { needle: 'captcha', provider: 'generic' },
  { needle: 'antibot', provider: 'generic' },
  { needle: 'antirobot', provider: 'generic' },
  { needle: 'cdn-cgi/challenge', provider: 'turnstile' },
  { needle: 'challenge-platform', provider: 'turnstile' },
  { needle: 'verify-human', provider: 'generic' },
  { needle: 'human-check', provider: 'generic' },
  { needle: 'areyouhuman', provider: 'generic' },
  { needle: 'notarobot', provider: 'generic' },
];

/**
 * Visible-text phrases (lower-cased, whitespace-normalized). English, Russian
 * and German — the languages of the default allowlist's marketplaces.
 */
const TEXT_PHRASES: readonly { phrase: string; provider: ChallengeProvider }[] = [
  { phrase: "i'm not a robot", provider: 'recaptcha' },
  { phrase: 'i am not a robot', provider: 'recaptcha' },
  { phrase: 'verify you are human', provider: 'generic' },
  { phrase: "verify you're human", provider: 'generic' },
  { phrase: 'confirm you are human', provider: 'generic' },
  { phrase: 'are you a robot', provider: 'generic' },
  { phrase: 'are you human', provider: 'generic' },
  { phrase: 'unusual traffic', provider: 'generic' },
  { phrase: 'checking your browser', provider: 'turnstile' },
  { phrase: 'just a moment', provider: 'turnstile' },
  { phrase: 'press and hold the button', provider: 'generic' },
  { phrase: 'drag the slider', provider: 'generic' },
  { phrase: 'select all images', provider: 'recaptcha' },
  { phrase: 'я не робот', provider: 'yandex' },
  { phrase: 'вы не робот', provider: 'yandex' },
  { phrase: 'подтвердите, что вы не робот', provider: 'yandex' },
  { phrase: 'подтвердите, что вы человек', provider: 'yandex' },
  { phrase: 'проверка на робота', provider: 'yandex' },
  { phrase: 'нестандартный трафик', provider: 'generic' },
  { phrase: 'ich bin kein roboter', provider: 'generic' },
  { phrase: 'sind sie ein roboter', provider: 'generic' },
  { phrase: 'sicherheitsprüfung', provider: 'generic' },
  { phrase: 'ungewöhnliche aktivitäten', provider: 'generic' },
];

/** Provider names visible in text let us classify the challenge further. */
const TEXT_PROVIDER_HINTS: readonly { needle: string; provider: ChallengeProvider }[] = [
  { needle: 'smartcaptcha', provider: 'yandex' },
  { needle: 'recaptcha', provider: 'recaptcha' },
  { needle: 'hcaptcha', provider: 'hcaptcha' },
  { needle: 'geetest', provider: 'geetest' },
  { needle: 'funcaptcha', provider: 'arkose' },
  { needle: 'arkose', provider: 'arkose' },
  { needle: 'turnstile', provider: 'turnstile' },
];

function safeParseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function hostMatches(hostname: string, rule: HostRule): boolean {
  for (const host of rule.hosts) {
    if (hostname === host || hostname.endsWith(`.${host}`)) return true;
  }
  return false;
}

function matchUrlAgainstRule(url: URL, rule: HostRule): boolean {
  if (hostMatches(url.hostname, rule)) return true;
  if (rule.pathNeedles) {
    const haystack = `${url.hostname}${url.pathname}`.toLowerCase();
    for (const needle of rule.pathNeedles) {
      if (haystack.includes(needle)) return true;
    }
  }
  return false;
}

function refineByText(text: string, fallback: ChallengeProvider): ChallengeProvider {
  for (const hint of TEXT_PROVIDER_HINTS) {
    if (text.includes(hint.needle)) return hint.provider;
  }
  return fallback;
}

/**
 * Classifies page signals into a probable challenge. Order of precedence:
 * iframe sources (strongest signal — provider frames), then the main URL,
 * then visible text.
 */
export function detectChallenge(signals: ChallengeSignals): ChallengeDetection {
  // 1. Frames: a known provider iframe means a challenge widget is embedded.
  for (const raw of signals.frameUrls ?? []) {
    const frameUrl = safeParseUrl(raw);
    if (!frameUrl) continue;
    if (frameUrl.protocol !== 'http:' && frameUrl.protocol !== 'https:') continue;
    for (const rule of HOST_RULES) {
      if (matchUrlAgainstRule(frameUrl, rule)) {
        return { detected: true, provider: rule.provider, signal: 'iframe' };
      }
    }
  }

  // 2. Main page URL: antibot interstitials and challenge paths.
  const mainUrl = safeParseUrl(signals.url);
  if (mainUrl) {
    for (const rule of HOST_RULES) {
      if (matchUrlAgainstRule(mainUrl, rule)) {
        return { detected: true, provider: rule.provider, signal: 'url' };
      }
    }
    const haystack = `${mainUrl.hostname}${mainUrl.pathname}`.toLowerCase();
    for (const { needle, provider } of MAIN_URL_NEEDLES) {
      if (haystack.includes(needle)) {
        return { detected: true, provider, signal: 'url' };
      }
    }
  }

  // 3. Visible text: challenge wording in EN/RU/DE.
  const text = (signals.visibleText ?? '')
    .slice(0, MAX_CHALLENGE_TEXT_SCAN_CHARS)
    .toLowerCase()
    .replace(/\s+/g, ' ');
  for (const { phrase, provider } of TEXT_PHRASES) {
    if (text.includes(phrase)) {
      return { detected: true, provider: refineByText(text, provider), signal: 'text' };
    }
  }

  return { detected: false };
}

/** Short human-readable provider label for safe explanations. */
export function challengeProviderLabel(provider: ChallengeProvider): string {
  switch (provider) {
    case 'recaptcha':
      return 'reCAPTCHA';
    case 'hcaptcha':
      return 'hCaptcha';
    case 'turnstile':
      return 'Cloudflare Turnstile';
    case 'geetest':
      return 'GeeTest';
    case 'arkose':
      return 'Arkose Labs';
    case 'yandex':
      return 'Yandex SmartCaptcha';
    case 'generic':
      return 'CAPTCHA';
  }
}

/**
 * Safe explanation for the model/user: provider label + hostname only.
 * Never contains page text, URL paths, or query strings.
 */
export function describeChallenge(
  detection: Extract<ChallengeDetection, { detected: true }>,
  hostname: string | undefined,
): string {
  const label = challengeProviderLabel(detection.provider);
  const where = hostname ? ` on ${hostname}` : '';
  return `Probable ${label} challenge detected${where} (matched by ${detection.signal}).`;
}
