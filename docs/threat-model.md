# Threat Model

## Assets

- The user's authenticated browser session
- Login state and business data visible in the browser
- CDP control authority
- Gateway bearer token

## Threats and controls

| Threat | Control |
| --- | --- |
| Internet reaches CDP | Bind locally or use an authenticated, CIDR-filtered gateway; never publish raw CDP. |
| SSRF through a CDP URL | Resolve and validate addresses, reject public/link-local/multicast targets, and pin the checked address. |
| Model extracts credentials | Never expose cookies, Local Storage, password fields, headers, tokens, or saved passwords. |
| Model performs a destructive action | Require an explicit human confirmation for purchases, messages, account changes, and form submission. |
| CAPTCHA bypass | Detect likely challenges and pause for visible human interaction. |
| Log exfiltration | Redact authorization, cookies, tokens, passwords, query strings, and CDP frames. |
| DNS rebinding | Re-check and pin the resolved target for the lifetime of a connection. |

## Assumptions

The host is trusted, Chrome runs visibly under a dedicated profile, and the
gateway token is stored outside the repository. A compromised host or Chrome
profile is outside this application's trust boundary.
