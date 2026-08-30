# Security Policy

## Supported versions

`baby-model` is self-hosted and released from `main`. Only the latest commit on
`main` receives security fixes; please update before reporting an issue.

| Version | Supported |
| ------- | --------- |
| `main` (latest) | :white_check_mark: |
| Older checkouts | :x: |

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/charles2ke/baby-model/security/advisories/new).
Please do not open a public issue for an unfixed vulnerability.

Include the affected version or commit, reproduction steps, and the impact you
believe the issue has. You can expect an acknowledgement within 5 working days
and a status update at least every 14 days. Accepted reports are fixed on
`main` and credited in the advisory unless you prefer to stay anonymous;
declined reports come with an explanation of the reasoning.

Please avoid privacy-invasive testing: never use another person's account or
documents, and test only against your own instance.

## Threat model and controls

- **Confidentiality** — documents and chunks are encrypted at rest with
  AES-256-GCM under a per-user data key wrapped by the server `MASTER_KEY`; the
  SQLite file is `0600` inside a `0700` directory.
- **Authentication** — `scrypt` password hashing, 256-bit session tokens stored
  only as SHA-256 hashes, `HttpOnly` + `SameSite=Strict` (+ `Secure` in
  production) cookies with server-side expiry.
- **CSRF** — a per-session token, compared in constant time, is required on
  every state-changing request.
- **Authorisation** — every query is scoped by `user_id`; cross-account access
  returns `404`.
- **Abuse** — global, per-question and per-authentication rate limits, upload
  size caps and UTF-8 text-only uploads.
- **Browser hardening** — `helmet` with a strict CSP (`default-src 'self'`, no
  framing, no object sources), `Referrer-Policy: no-referrer`,
  `Permissions-Policy` denying device access and `Cache-Control: no-store`.
- **Crawlers and AI scrapers** — `robots.txt` disallows every user agent,
  including LLM crawlers, and every response carries a restrictive
  `X-Robots-Tag`. Confidential data is only ever served to an authenticated
  session, so a crawler that ignores both still sees nothing but the sign-in
  page.
- **Prompt injection** — answers are extractive and generated locally; text
  taken from stored documents has instruction-like passages, invisible
  characters and exfiltration URLs redacted before it is returned. This is
  defence in depth: treat every answer, excerpt and title as untrusted data,
  never as instructions for another model or agent.

## Known residual risks

- Registering an email that already has a vault returns `409`, so a determined
  attacker can still probe whether an address is registered. Responses are kept
  generic and the work is equalised, but only an out-of-band confirmation flow
  would remove the oracle entirely.
- Prompt-injection redaction is pattern based and cannot recognise every
  possible phrasing.
- The `MASTER_KEY` protects data at rest against database theft only; an
  attacker with code execution on the host can read decrypted data.

## Deployment expectations

Run behind HTTPS with `NODE_ENV=production`, supply `MASTER_KEY` from a secret
manager, set `TRUST_PROXY=1` only when a trusted reverse proxy sets
`X-Forwarded-For`, and back up the data directory as encrypted material.
