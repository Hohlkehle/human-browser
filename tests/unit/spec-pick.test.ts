/**
 * Offline semantics of the spec engine — a 1:1 port of the assertions the
 * `graber-web` skill ran in `scripts/selftest.py` (verified against the Python
 * caller's real output before the port), so a spec learned with Python keeps
 * behaving identically inside the MCP server.
 */
import { describe, expect, it } from 'vitest';
import {
  checkMissing,
  extractBrowserText,
  extractHtml,
  extractJson,
  fill,
  getPath,
  pickValue,
} from '../../src/spec/pick.js';
import { SpecPatternError, compileSpecPattern, translatePattern } from '../../src/spec/regex.js';

describe('pick pattern semantics', () => {
  it('mixed named + unnamed groups fall back to the first non-None group', () => {
    expect(
      pickValue('<b>ABC-42', { name: 'x', pattern: '<b>(?:<i>)?(?P<named>[A-Z]+)(?:-(\\d+))?' }, {}),
    ).toBe('ABC');
  });

  it('every group named yields a dict (the title/loc feature)', () => {
    expect(
      pickValue(
        '<title>Rad in Berlin - Mitte</title>',
        { name: 't', pattern: '<title>(?P<title>.+?)\\s+in\\s+(?P<loc>[^|<]+?)\\s*</title>' },
        {},
      ),
    ).toEqual({ title: 'Rad', loc: 'Berlin - Mitte' });
  });

  it('no groups yields the whole match', () => {
    expect(pickValue('pre<em>hit</em>post', { name: 'x', pattern: 'hit' }, {})).toBe('hit');
  });

  it('decode json_string turns \\u escapes into real characters', () => {
    expect(
      pickValue('"a\\u00e4b"', { name: 'x', pattern: '"([^"]+)"', decode: 'json_string' }, {}),
    ).toBe('aäb');
  });

  it('a missing match is null, not an empty string', () => {
    expect(pickValue('nothing here', { name: 'x', pattern: 'nope-(\\d+)' }, {})).toBeNull();
  });

  it('all + dedupe returns matches in order without repeats', () => {
    const result = pickValue(
      'a1 b2 a1 c3',
      {
        name: 'x',
        pattern: '([a-z]\\d)',
        all: true,
        dedupe: true,
      },
      {},
    );
    expect(result).toEqual(['a1', 'b2', 'c3']);
  });

  it('placeholders are filled from the call params', () => {
    expect(fill('https://s.tld/{slug}/{code}', { slug: 'mini-pc', code: '3331' })).toBe(
      'https://s.tld/mini-pc/3331',
    );
    expect(fill('/x/{unknown}', {})).toBe('/x/{unknown}');
  });
});

describe('pattern translation (Python re → JS)', () => {
  it('rewrites named groups and inline flag groups', () => {
    expect(translatePattern('(?P<adid>\\d+)')).toBe('(?<adid>\\d+)');
    expect(translatePattern('(?s:.*?)</article>')).toBe('(?:.*?)</article>');
    expect(translatePattern('(?<=x)(?<!y)(?:z)')).toBe('(?<=x)(?<!y)(?:z)');
  });

  it('rewrites Python absolute anchors (\\Z / \\A) instead of matching a literal Z', () => {
    expect(translatePattern('(?=<article|\\Z)')).toBe('(?=<article|$)');
    expect(translatePattern('\\Aabc')).toBe('^abc');
    expect(translatePattern('x|\\Z')).toBe('x|$');
  });

  it('refuses inline flags it cannot translate faithfully', () => {
    expect(() => translatePattern('(?i:abc)')).toThrow(SpecPatternError);
  });

  it('compiles with DOTALL so . crosses newlines like re.S', () => {
    const re = compileSpecPattern('a.*b');
    expect(re.test('a\nb')).toBe(true);
  });
});

describe('html extraction (list mode)', () => {
  const HTML =
    '<article data-adid="1" data-href="/a"><h3><span>Alpha</span></h3>' +
    '<article data-adid="2" data-href="/b"><h3><a>Beta</a></h3>' +
    '<article data-adid="3" data-href="/c"><h3>Gamma</h3>';
  const RESPONSE = {
    format: 'html' as const,
    item_pattern: 'data-adid="(?P<adid>\\d+)" data-href="(?P<href>[^"]+)">(?s:.*?)(?=<article|\\Z)',
    pick: [{ name: 'title', pattern: '<h3[^>]*>(?:<span|<a)[^>]*>([^<]+)</(?:span|a)></h3>' }],
  };

  it('extracts one row per item, seeding the item pattern groups', () => {
    const rows = extractHtml(HTML, RESPONSE, {}) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ adid: '1', href: '/a', title: 'Alpha' });
    expect(rows[1]).toMatchObject({ adid: '2', href: '/b', title: 'Beta' });
    // The third card uses a markup variant the pattern does not cover.
    expect(rows[2]).toMatchObject({ adid: '3', href: '/c', title: null });
  });

  it('check sees the mid-list hole instead of passing on row 0', () => {
    const rows = extractHtml(HTML, RESPONSE, {});
    expect(checkMissing(rows, ['title', 'adid', 'href'])).toEqual({
      missing: ['2:title'],
      rows: 3,
    });
  });

  it('single-object mode truncates the body at slice_before', () => {
    const body = '<h1>Wanted</h1><div id="cut"><h1>Similar ad</h1>';
    const data = extractHtml(
      body,
      { format: 'html', slice_before: 'id="cut"', pick: [{ name: 'title', pattern: '<h1>([^<]+)</h1>' }] },
      {},
    );
    expect(data).toEqual({ title: 'Wanted' });
  });
});

describe('check contract', () => {
  it('reports every empty expected field of a single object', () => {
    expect(checkMissing({ a: '' }, ['a', 'b'])).toEqual({ missing: ['0:a', '0:b'], rows: 1 });
  });

  it('reports nothing extracted as a failure, not a pass', () => {
    expect(checkMissing([], ['a'])).toEqual({ missing: ['<no rows extracted>'], rows: 0 });
  });

  it('fields outside expect may be null', () => {
    expect(checkMissing([{ title: 't', price: null }], ['title'])).toEqual({ missing: [], rows: 1 });
  });
});

describe('json extraction', () => {
  const BODY = JSON.stringify({
    data: { items: [{ id: 1, ad: { title: 'One' }, price: '12\\u20ac' }, { id: 2, ad: { title: 'Two' } }] },
  });

  it('walks extract, picks paths and honours multi', () => {
    const data = extractJson(
      BODY,
      {
        format: 'json',
        extract: 'data.items',
        pick: ['id', { name: 'title', path: 'ad.title' }, { name: 'price', path: 'price', decode: 'json_string' }],
        multi: true,
      },
      {},
    );
    expect(data).toEqual([
      { id: 1, title: 'One', price: '12€' },
      { id: 2, title: 'Two', price: null },
    ]);
  });

  it('unwraps a single item unless multi is set', () => {
    const one = JSON.stringify({ data: [{ id: 7 }] });
    expect(extractJson(one, { format: 'json', extract: 'data', pick: ['id'] }, {})).toEqual({ id: 7 });
    expect(extractJson(one, { format: 'json', extract: 'data', pick: ['id'], multi: true }, {})).toEqual([
      { id: 7 },
    ]);
  });

  it('returns null when the extract path is absent (site changed?)', () => {
    expect(extractJson('{"data":{}}', { format: 'json', extract: 'data.items' }, {})).toBeNull();
  });

  it('supports a raw template instead of the body', () => {
    expect(
      extractJson('ignored', { format: 'json', raw: '{"data":[{"id":"{code}"}]}', extract: 'data', pick: ['id'] }, { code: 'A1' }),
    ).toEqual({ id: 'A1' });
  });
});

describe('browser-text extraction', () => {
  // The learned pro-motointegrator picks, applied to the whitespace-collapsed
  // card blob that site really returns (the skill's pitfalls 12/13 live here).
  const CARD =
    'CASTROL 15F7E7 Fabricant: CASTROL Numéro du fabricant: 468567 Voir plus 44,44 € Prix HT, hors frais de port En stock Le jour ouvré suivant';
  const CARD_PICKS = [
    { name: 'title', pattern: '^(.+?)\\s+Fabricant:' },
    { name: 'brand', pattern: 'Fabricant:\\s*(.+?)\\s+Num[ée]ro du fabricant:' },
    { name: 'ref', pattern: 'Num[ée]ro du fabricant:\\s*(.+?)\\s*(?:Voir plus|Voir moins|Ajouter|$)' },
    { name: 'price_raw', pattern: '(\\d[\\d\\s\\u00a0]*,\\d{2})\\s*€' },
    {
      name: 'availability',
      pattern:
        '(En stock|Quantité limitée|Faible quantité|Temporairement indisponible|Bientôt de retour|Sur commande|Indisponible)',
    },
  ];

  it('applies the learned picks to a live card blob (single object)', () => {
    const data = extractBrowserText([CARD], { format: 'browser-text', pick: CARD_PICKS }, {});
    expect(data).toEqual({
      title: 'CASTROL 15F7E7',
      brand: 'CASTROL',
      ref: '468567',
      price_raw: '44,44',
      availability: 'En stock',
    });
  });

  it('keeps a card without a price distinguishable from a zero price', () => {
    const card =
      'ENGITECH ENT250416/1 Fabricant: ENGITECH Numéro du fabricant: ENT250416/1 Voir plus Temporairement indisponible';
    const data = extractBrowserText([card], { format: 'browser-text', pick: CARD_PICKS }, {}) as Record<
      string,
      unknown
    >;
    expect(data.price_raw).toBeNull();
    expect(data.availability).toBe('Temporairement indisponible');
  });

  it('is list mode when item_pattern is present (one blob per element)', () => {
    const data = extractBrowserText(
      ['Alpha 1 €', 'Beta 2 €'],
      { format: 'browser-text', item_pattern: '', pick: [{ name: 'name', pattern: '^([A-Za-z]+)' }] },
      {},
    );
    expect(data).toEqual([{ name: 'Alpha' }, { name: 'Beta' }]);
  });

  it('has no data when the page text is empty', () => {
    expect(extractBrowserText([], { format: 'browser-text', pick: [{ name: 'x', pattern: 'hit' }] }, {})).toEqual({
      x: null,
    });
  });
});

describe('getPath', () => {
  it('walks objects, arrays and missing keys like the Python caller', () => {
    expect(getPath({ a: { b: [{ c: 1 }] } }, 'a.b.0.c')).toBe(1);
    expect(getPath({ a: 1 }, 'a.b')).toBeUndefined();
    expect(getPath({ a: [1] }, 'a.5')).toBeUndefined();
    expect(getPath('scalar', 'a')).toBeUndefined();
  });
});
