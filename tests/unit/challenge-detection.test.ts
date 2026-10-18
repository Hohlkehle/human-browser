/**
 * Stage 6 unit tests: probable-CAPTCHA detection (pure classification).
 */
import { describe, expect, it } from 'vitest';
import {
  challengeProviderLabel,
  describeChallenge,
  detectChallenge,
  type ChallengeSignals,
} from '../../src/human/challenge.js';

function signals(overrides: Partial<ChallengeSignals> = {}): ChallengeSignals {
  return {
    url: 'https://partslink24.com/catalog',
    frameUrls: ['https://partslink24.com/catalog'],
    visibleText: 'Auto parts catalog for VAG vehicles',
    ...overrides,
  };
}

describe('detectChallenge: iframe signals (provider widgets)', () => {
  const frames: Array<[string, string]> = [
    ['https://www.google.com/recaptcha/api2/anchor?k=abc', 'recaptcha'],
    ['https://www.recaptcha.net/recaptcha/api.js', 'recaptcha'],
    ['https://js.hcaptcha.com/1/api.js', 'hcaptcha'],
    ['https://challenges.cloudflare.com/turnstile/v0/api.js', 'turnstile'],
    ['https://api.geetest.com/get.php', 'geetest'],
    ['https://client-api.arkoselabs.com/v2/abc/enforcement.html', 'arkose'],
    ['https://abc.funcaptcha.com/iframe', 'arkose'],
    ['https://check.smartcaptcha.yandexcloud.net/check?token=x', 'yandex'],
  ];

  for (const [frameUrl, provider] of frames) {
    it(`detects ${provider} from frame ${new URL(frameUrl).hostname}`, () => {
      const detection = detectChallenge(signals({ frameUrls: [frameUrl] }));
      expect(detection).toMatchObject({ detected: true, provider, signal: 'iframe' });
    });
  }

  it('ignores non-recaptcha Google/gstatic iframes', () => {
    const detection = detectChallenge(
      signals({
        frameUrls: [
          'https://www.google.com/maps/embed?pb=...',
          'https://www.google.com/ads/...',
          'https://www.gstatic.com/cdn-cgi/challenge-platform/...',
          'https://www.google.com/recaptcha/api2/anchor?k=abc',
        ],
      }),
    );
    // Only the recaptcha URL should trigger detection (via pathNeedle).
    expect(detection).toMatchObject({ detected: true, provider: 'recaptcha', signal: 'iframe' });
  });

  it('ignores non-http frames and first-party frames', () => {
    const detection = detectChallenge(
      signals({
        frameUrls: [
          'about:blank',
          'chrome-extension://abc/frame.html',
          'https://partslink24.com/embedded/cart',
        ],
      }),
    );
    expect(detection).toEqual({ detected: false });
  });

  it('ignores unparseable frame URLs', () => {
    const detection = detectChallenge(signals({ frameUrls: ['not a url', ''] }));
    expect(detection).toEqual({ detected: false });
  });
});

describe('detectChallenge: main URL signals', () => {
  it('detects the Cloudflare interstitial path', () => {
    const detection = detectChallenge(
      signals({ url: 'https://partslink24.com/cdn-cgi/challenge-platform/h/b/orchestrate' }),
    );
    expect(detection).toMatchObject({ detected: true, provider: 'turnstile', signal: 'url' });
  });

  it('detects explicit captcha/antibot paths', () => {
    expect(
      detectChallenge(signals({ url: 'https://partslink24.com/captcha/check' })),
    ).toMatchObject({ detected: true, signal: 'url' });
    expect(
      detectChallenge(signals({ url: 'https://partslink24.com/antibot?next=1' })),
    ).toMatchObject({ detected: true, signal: 'url' });
  });

  it('does not flag bare "challenge" words in unrelated paths', () => {
    const detection = detectChallenge(
      signals({ url: 'https://partslink24.com/catalog/oil-filters' }),
    );
    expect(detection).toEqual({ detected: false });
  });
});

describe('detectChallenge: visible text signals', () => {
  const phrases: Array<[string, string]> = [
    ["Please confirm: I'm not a robot", 'recaptcha'],
    ['VERIFY YOU ARE  HUMAN to continue', 'generic'],
    ['We detected unusual traffic from your network', 'generic'],
    ['Just a moment... Checking your browser before continuing', 'turnstile'],
    ['Подтвердите, что вы не робот', 'yandex'],
    ['Я не робот', 'yandex'],
    ['Bitte bestätigen: Ich bin kein Roboter', 'generic'],
    ['Select all images with traffic lights', 'recaptcha'],
  ];

  for (const [text, provider] of phrases) {
    it(`detects challenge text "${text.slice(0, 40)}..."`, () => {
      const detection = detectChallenge(signals({ visibleText: text }));
      expect(detection).toMatchObject({ detected: true, provider, signal: 'text' });
    });
  }

  it('refines the provider from text hints (smartcaptcha -> yandex)', () => {
    const detection = detectChallenge(
      signals({ visibleText: 'smartcaptcha check: confirm you are human' }),
    );
    expect(detection).toMatchObject({ detected: true, provider: 'yandex', signal: 'text' });
  });

  it('is case- and whitespace-insensitive', () => {
    const detection = detectChallenge(signals({ visibleText: "i'm   NOT\ta  ROBOT" }));
    // Normalization collapses whitespace; the apostrophe form still matches.
    expect(detection.detected).toBe(true);
  });

  it('does not flag ordinary shop text', () => {
    const detection = detectChallenge(
      signals({
        visibleText:
          'Original parts catalog. Add to cart, checkout is available for registered authors. Contact the author of the article.',
      }),
    );
    expect(detection).toEqual({ detected: false });
  });

  it('scans only the capped prefix of huge texts', () => {
    const padded = 'x'.repeat(20_000) + " i'm not a robot";
    expect(detectChallenge(signals({ visibleText: padded })).detected).toBe(false);
  });
});

describe('detectChallenge: precedence', () => {
  it('iframe beats text beats url ordering (iframe first)', () => {
    const detection = detectChallenge(
      signals({
        url: 'https://partslink24.com/captcha/check',
        frameUrls: ['https://js.hcaptcha.com/1/api.js'],
        visibleText: "I'm not a robot",
      }),
    );
    expect(detection).toMatchObject({ detected: true, provider: 'hcaptcha', signal: 'iframe' });
  });
});

describe('safe explanation', () => {
  it('contains provider label and hostname but never URL paths', () => {
    const detection = detectChallenge(
      signals({ frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=SECRET'] }),
    );
    expect(detection.detected).toBe(true);
    if (!detection.detected) return;
    const explanation = describeChallenge(detection, 'partslink24.com');
    expect(explanation).toContain('reCAPTCHA');
    expect(explanation).toContain('partslink24.com');
    expect(explanation).not.toContain('SECRET');
    expect(explanation).not.toContain('/recaptcha');
  });

  it('labels all providers', () => {
    expect(challengeProviderLabel('recaptcha')).toBe('reCAPTCHA');
    expect(challengeProviderLabel('hcaptcha')).toBe('hCaptcha');
    expect(challengeProviderLabel('turnstile')).toBe('Cloudflare Turnstile');
    expect(challengeProviderLabel('geetest')).toBe('GeeTest');
    expect(challengeProviderLabel('arkose')).toBe('Arkose Labs');
    expect(challengeProviderLabel('yandex')).toBe('Yandex SmartCaptcha');
    expect(challengeProviderLabel('generic')).toBe('CAPTCHA');
  });
});
