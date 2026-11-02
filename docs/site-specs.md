# Learned site specs (site_list / site_op / site_check)

A **site spec** is a site's data format, learned once and replayed cheaply.

The idea: a site's data is already structured — the frontend just hides it
behind HTML or an internal XHR. Instead of re-exploring the site on every task,
learn the format ONCE (a URL template plus regex picks), save it as a local
JSON file, and from then on every call is a single `site_op`: no re-discovery,
no guessing field names, scriptable and cheap.

The engine lives in `src/spec/` and is a faithful port of the Python caller
that shipped with the standalone `graber-web` skill, so the same spec files
work with both. This is what the MCP server adds on top of browsing: the
twenty-first call to a site costs one tool call, not another round of clicking.

## Where the files live

Specs are read from **`SITE_SPECS_DIR`** (default `<cwd>/specs`) and are
deliberately **not committed**: they record a site's internal data format,
endpoints and quirks, and the project rule is that nothing like that is ever
published, pushed or pasted anywhere. The repository ships the engine, this
document and a synthetic example (`examples/site-specs/example.json`).

A missing directory is not fatal: the tools answer with a clear
`specs_dir_missing` error naming the directory they expected.

## Tools

| Tool | What it does |
| --- | --- |
| `site_list` | Lists the learned specs: each op with its parameters, transport and whether it carries a `check`. Start here. |
| `site_op` | Runs one op and returns its rows (`site`, `op`, `params`, `limit`). `ok:false` → error result `site_no_data` with the reason in `opError`. `rows` is the total, `data` is capped by `limit` (default 25) and `truncated` says so. |
| `site_check` | Runs the op with the spec's holdout params and validates **every** row against the expected fields, reporting `rowIndex:field`. A failing check is an answer (`ok:false`), not a tool error. |

All three are read-only (no clicks, no forms) and are refused while human
control is paused, so the user can finish a CAPTCHA/login unseen.

## Spec format

```json
{
  "name": "site-name",
  "displayName": "Human name + purpose",
  "baseUrl": "https://example.com",
  "description": "What this site gives us; known quirks (anti-bot, region codes...)",
  "learned_at": "2026-11-01T01:40:00+02:00",
  "learned_by": "graber-web",
  "ops": { "<opName>": { "description": "...", "url": "...", "response": { "...": "..." }, "check": { "...": "..." } } }
}
```

### Operation

```json
{
  "description": "What it returns (field semantics, what null means)",
  "transport": "http",
  "method": "GET",
  "url": "https://example.com/path-{slug}/{code}",
  "headers": { "accept-language": "de-DE,de;q=0.9" },
  "body": null,
  "timeout": 30,
  "retries": 1,
  "retry_wait": 5.0,
  "cookies_file": "/root/.cookies/example.com",
  "params": [{ "name": "slug", "example": "mini-pc", "hint": "lowercase, hyphenated" }],
  "response": { "format": "html", "item_pattern": "...", "pick": ["..."] },
  "check": { "params": { "slug": "gaming-laptop" }, "expect": ["title", "price"] }
}
```

- `url`, `headers`, `body`: `{param}` placeholders are replaced from the tool's
  `params`.
- `cookies_file`: a PATH to a local file holding the `Cookie` header value.
  Never put a cookie value inside a spec.
- `retries` / `retry_wait`: applied on 5xx and network errors (anti-bot bursts).
- `check`: holdout params (a real value different from the learning args) plus
  the fields that must be non-empty **in every row**. `site_check` is the
  contract to run after any site change — it fails loudly instead of returning
  plausible-looking empty data.
- A URL outside `BROWSER_ALLOWED_DOMAINS` is refused before any request: a spec
  can never become a way around the allowlist.

### `transport`

- omitted / `"http"` — plain fetch, no browser (the cheap default).
- `"browser-mcp"` — drive the user's authenticated visible Chrome through this
  same server, for login/Cloudflare-walled sites. Extra fields:
  - `url` — page to load (same placeholders); prefer the site's own query.
  - `tab_match` — URL substring of the tab this op may reuse; that tab belongs
    to the workflow by contract, and the op never navigates any other tab. No
    match → a NEW tab is opened.
  - `wait_selector` — CSS selector waited for as visible; a timeout is **not**
    an error (an empty result page is a valid outcome).
  - `item_selector` — list mode: one text blob per matching element; omit for
    single-object mode over `text_selector` (default `body`).
  - `settle` (seconds) and `wait_timeout_ms` — pacing knobs.
  - Extraction is visible TEXT only: no attributes, no JavaScript, no cookies.
    Card links come from `page_snapshot`'s `/url:` lines in DOM order.

### `response.format`

**`json`** (default) — the endpoint returns JSON:
```json
"response": {
  "format": "json",
  "raw": "",
  "extract": "data.items",
  "pick": ["id", { "name": "title", "path": "ad.title", "decode": "json_string" }],
  "multi": true
}
```
`extract` is a dot path to the items; a single item is unwrapped unless `multi`
is set. `raw` parses a placeholder template instead of the response body.

**`embedded-json`** — a JSON blob inside HTML (`extract` is a regex; group 1 or
the whole match is parsed, then `pick` runs).

**`html`** — SSR page, regex forensics:
```json
"response": {
  "format": "html",
  "slice_before": "id=\"viewad-description\"",
  "item_pattern": "data-adid=\"(?P<adid>\\d+)\">(?s:.*?)</article>",
  "pick": [
    { "name": "title", "pattern": "<h3[^>]*>(?:<span|<a)[^>]*>([^<]+)</(?:span|a)></h3>" },
    { "name": "gallery", "pattern": "https://img\\.example\\.de/photos/[a-f0-9-]+", "all": true, "dedupe": true }
  ]
}
```
- `item_pattern` present → **list mode**: each match is one row, its named groups
  seed the row, the picks run INSIDE the segment.
- otherwise **single-object mode** over the whole body; `slice_before` is a plain
  substring that truncates the body first (e.g. to cut off a "similar ads" block).
- Pick semantics: no groups → the whole match; groups → the first non-None group;
  **every** group named → `{name: value}` (a mixed named+unnamed pattern is
  treated as plain groups); `all: true` → a list; `dedupe: true` → ordered
  dedupe; `decode`: `json_string` (recommended) or `unicode_escape` (legacy).
- All patterns run with DOTALL. Python-only constructs are translated:
  `(?P<name>...)` → `(?<name>...)`, `(?s:...)` → `(?:...)`, `\Z`/`\A` → `$`/`^`.
  An inline flag group that cannot be translated faithfully (`(?i:...)`) throws
  instead of silently matching something else.

**`browser-text`** — informational for the browser transport; the `pick`
patterns are the very same regex picks applied to each extracted blob.

## Re-learning an op

When `site_op` returns `ok:false` ("no data at extract path (site changed?)") or
`site_check` reports `missing` fields:

1. Re-explore that one page in the visible Chrome (`page_snapshot`,
   `page_extract`) — the site restructured.
2. Update the op's patterns, keeping the old spec as a `.bak` until the new one
   passes.
3. Run `site_check` again, and one live `site_op` with a real parameter.
4. Pattern updates must be verified on BOTH markup variants: a check may only
   exhibit the old variant, and broadening a pattern can silently break it.
