# Partslink24 end-to-end scenario (Stage 9)

The reference scenario for the whole project: search a vehicle on
`www.partslink24.com` and extract catalog part numbers + applicability —
**without the AI ever seeing the password**, and with every CAPTCHA handed to
the human.

## The flow

| # | Who  | What                                                                                     |
| - | ---- | ---------------------------------------------------------------------------------------- |
| 1 | MCP  | `browser_connect`, then `page_open https://www.partslink24.com/`                          |
| 2 | MCP  | Login wall detected (password field / login wording in the ARIA snapshot) → `human_required`. On the live site the wall appears deeper than the homepage (see "Real results") — the engine re-checks at every wait/probe point |
| 3 | User | Signs in **manually in the visible Chrome window** — credentials are typed there only    |
| 4 | MCP  | `human_resume`; the snapshot is re-checked: the wall must be gone                          |
| 5 | MCP  | `page_fill` the VIN into the search field, `page_click` search                            |
| 6 | MCP  | CAPTCHA detected (server-side challenge scan) → automation stops, tab brought to front    |
| 7 | User | Solves the CAPTCHA manually                                                               |
| 8 | MCP  | `human_resume` verifies the challenge is gone and continues **the same tab/session**      |
| 9 | MCP  | `page_extract` — ONLY the requested part numbers and their applicability                  |

The scripted driver is `src/scenarios/partslink24.ts`
(`runPartslink24Scenario`): transport-agnostic, it calls the MCP tools exactly
like an AI client would and invokes a `waitForUser` callback at every handoff.

## Security rules enforced by the scenario

- **No password to the AI.** The engine never fills or reads credentials; the
  login wall is handed to the user before any field is touched. `page_fill`
  refuses password fields anyway (Stage 4), and while the gate is paused every
  `page_*` tool — including reads — is refused, so the model cannot observe
  what the user types.
- **No cookies/tokens/JS.** The scenario uses only the 15 MCP tools; nothing
  reads cookies, localStorage, or evaluates JavaScript.
- **VIN privacy.** The VIN is passed to `page_fill` only (the adapter never
  echoes or logs fill values). Everywhere else — logs, reports, console
  output — only the masked form survives (`src/policy/vin.ts`): the WMI and
  the serial tail stay visible, the middle characters become `*`
  (`WVWZZZ1KZAW123456` → `WVW********123456`).
- **No purchases/orders.** A `confirmation_required` answer aborts the
  scenario instead of consuming a confirm token; the flow ends at extraction.
- **CAPTCHA is never solved automatically.** Detection pauses automation
  (`captcha_detected`), `human_resume` re-scans and rejects a resume while the
  challenge is still present (`challenge_still_present`).

## CI mock scenario (no contact with Partslink24)

`tests/integration/partslink24-e2e.test.ts` runs the FULL flow against a local
Partslink24-like fixture with the real stack (disposable Chrome → adapter →
human gate → MCP over Streamable HTTP → SDK client → scenario engine). The
fixture is cookie-based, so it also proves "no re-login": the session granted
by the simulated manual login carries through search → CAPTCHA → results on
the same tab. The simulated human acts via direct tab navigation — the
automation itself never POSTs the login form (asserted) and never solves the
CAPTCHA. Engine logic (handoff rounds, verified resume, late-challenge probe,
VIN masking, sensitive-action refusal) is covered without Chrome in
`tests/unit/partslink24-scenario.test.ts` and `tests/unit/vin.test.ts`.

```powershell
npm test   # includes the mock E2E (skipped only when no Chrome is installed)
```

## Real run

Prerequisites:

1. Stages 1–8 running: visible Chrome with `--remote-debugging-port=9222`,
   `npm start` healthy (`http://127.0.0.1:9230/healthz`), or the Stage 8
   service. `BROWSER_ALLOWED_DOMAINS` already defaults to
   `partslink24.com,www.partslink24.com,...`.
2. A Partslink24 account you can sign in with (you type the password into
   Chrome yourself).
3. A VIN to search.

Run (the VIN comes from `--vin`, `PL24_VIN`, or an interactive prompt — argv
is visible to other local processes, so prefer the env variable or prompt):

```powershell
npm run build
$env:PL24_VIN = '<your VIN>'
npm run e2e:partslink24
# or: node dist/src/scenarios/partslink24-cli.js --vin <VIN>
```

The CLI prints a `--- HANDOFF ---` block whenever the human must act; finish
the action in Chrome and press Enter. The final report (masked VIN, handoff
count, part numbers, applicability) is printed as markdown.

An AI client (ChatGPT connector / Codex CLI) can run the same flow manually
with the 15 tools in the table above; the engine is only a scripted reference
client.

### Tuning the locators

The real-site locators live in `PARTSLINK24_SCRIPT`
(`src/scenarios/partslink24.ts`) and are best-effort: the Partslink24 markup
can change. If a step fails with a locator error, open the tab, call
`page_snapshot`, pick a stable role/label/CSS locator from the YAML, and pass
a custom script (or update the constant). The flow itself is site-independent.

Observed on the live site (see the recorded run below): the homepage is a
**brand-selection grid** (52+ brand buttons) — the VIN search field and the
login wall appear deeper (brand catalog / account pages, LexCom
`*.action` URLs). A real run may therefore need a script whose `startUrl` is a
deeper page, or a manual brand selection before the search step; the engine
handles the login wall whenever the snapshot shows one at the start, and the
handoff mechanism covers later walls via the CAPTCHA/wait loop.

## Real results

Record every real run here (masked VIN only). Template:

```markdown
### <date> — <operator initials>

- VIN: <masked, e.g. WVW********123456>
- Login handoff: <rounds>, CAPTCHA handoff: <rounds>
- Same tab/session throughout: yes/no
- Part numbers: <list>
- Applicability: <list>
- Notes: <locator adjustments, CAPTCHA provider, anomalies>
```

Status of recorded runs:

### 2026-08-27 — bounded homepage probe (no account)

- VIN: not used (homepage probe only; no search performed).
- The homepage loaded once per probe (`/` → `/ru/index.html`, Russian locale,
  `countryCode=UA`), via the real adapter + challenge scan + ARIA snapshot:
  - **no CAPTCHA on open** (`detectChallenge` → not detected);
  - **no login wall on the homepage** (`detectLoginWall` → not detected): the
    page is a brand-selection grid ("Более 52 брендов… с одним входом!") with
    a registration link (`/partslink24/registration-data.action`) and legal
    footer; login/VIN search live deeper in the brand catalogs.
- Full login → search → CAPTCHA → extraction flow on the real site requires a
  Partslink24 account and is performed by the user via
  `npm run e2e:partslink24`; the complete flow incl. both handoffs is proven
  by the mock CI scenario.
