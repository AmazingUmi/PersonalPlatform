# AUTH-H1 — Authentication Hardening Worklist

Scope: small, surgical fixes to the existing Core Auth implementation. This is
hardening, not a redesign: `platformApiVersion = 1`, session schema, `ctx.auth`,
`Storage.forUser()`, ownership SQL and the modular architecture are untouched.

## Objective

Close six boundary issues found in the shipped AUTH-1/AUTH-multi-user
implementation, plus the matching frontend failure-state behavior.

## Current gaps (verified against source)

| ID | Gap | Source |
| ---- | ---- | ---- |
| H1-01 | Auth guard swallows datastore errors → 401 instead of 503 | `core/auth/guard.ts` `.catch(() => null)` |
| H1-02 | Secure cookie depends on yaml-only `environment`; no reliable production override | `core/platform.ts` + `core/config/index.ts` |
| H1-03 | No `trustProxy` config; login limiter keys on proxy/container IP | `core/platform.ts` Fastify() opts, `core/auth/routes.ts` |
| H1-04 | Logout requires auth → expired session answers 401, cookie not cleared | `core/auth/routes.ts` |
| H1-05 | Bootstrap with a different username creates a second admin | `core/auth/service.ts` `ensureBootstrapAdmin` |
| H1-06 | Storage follows final-component symlinks (read/write/delete/exists) and walks symlink dirs/files in `list` | `core/storage/local.ts` |
| FE | `/me` 5xx/network failure bootstraps the shell as "anonymous" | `frontend/src/shell/AuthContext.tsx` |

## Decisions

- **H1-01** Guard distinguishes: no cookie/invalid/expired/disabled → 401;
  datastore throw → 503 `database_unavailable` envelope, generic message,
  full error logged server-side. Admin guard unchanged except the same 503
  path (authorization failure stays 403).
- **H1-02** Precedence: `SESSION_COOKIE_SECURE` env (`true`/`false`) >
  `PLATFORM_ENVIRONMENT` env > `platform.environment` yaml. `Secure` iff the
  resolved environment is `production`, unless explicitly overridden. Never
  inferred from request headers.
- **H1-03** Fastify native `trustProxy` option, resolved from `TRUST_PROXY`
  env > `platform.trust_proxy` yaml. Unset/`false`/`0` → do not trust (default,
  no local-dev config needed). `true`/`1` → trust all (only safe when the
  backend is unreachable except through the proxy — documented). Any other
  string is passed to Fastify/proxy-addr verbatim (`loopback`, `uniquelocal`,
  CIDR/IP lists). No hand-rolled IP parsing.
- **H1-04** Logout drops `requireAuth`: best-effort session delete when a
  token cookie exists, always `clearCookie`, always 204, never reveals whether
  the session was valid.
- **H1-05** Bootstrap = first admin only. Active admin exists + no pending
  placeholder → noop (`reason: "no-pending-and-exists"` + warning log), even
  with a different username/password in env. Activated passwords are never
  rewritten (existing invariant, kept). If no admin exists at all, bootstrap
  can still create one (recovery path).
- **H1-06** `lstat` the final path component inside `assertWithinRoot`: symlink
  → `invalid_path` (root itself exempt — realpath'd once, operator-provided).
  `list()` validates its prefix through the same check; `walk()` skips symlink
  entries entirely. `exists()` keeps its catch-all → `false` contract.
- **FE** `AuthStatus: loading | authenticated | anonymous | error`; `/me` 401 →
  anonymous (login page), network/5xx → error (backend-unavailable screen with
  retry). No error-management framework.

## Task breakdown

1. Backend: guard 503 semantics + unit tests.
2. Backend: config env overrides (environment / cookie secure / trust proxy) + unit tests.
3. Backend: platform wiring (Fastify `trustProxy`, cookie secure resolution).
4. Backend: idempotent logout + integration tests.
5. Backend: bootstrap second-admin guard + CLI message + integration tests.
6. Backend: storage symlink hardening + unit tests.
7. Frontend: error auth status + retry UI + unit tests.
8. Docs/config: `.env.example`, `docker-compose.yml`, README.
9. Full canonical gates.

## Non-goals

RLS, OAuth/SSO, email, password reset, user deletion, self-service password
change, 2FA, per-user app enable/settings, Redis rate limiting, session device
management, CSRF token system, `platformApiVersion` bump, auth schema redesign,
unrelated refactors/formatting.

## Acceptance criteria (gates)

- AUTH-H1-GATE-01 DB auth failure returns 503, not 401
- AUTH-H1-GATE-02 Production session cookie is Secure
- AUTH-H1-GATE-03 Forwarded IP trusted only under explicit trusted-proxy config
- AUTH-H1-GATE-04 Logout is idempotent and always clears cookie
- AUTH-H1-GATE-05 Bootstrap cannot accidentally create a second admin
- AUTH-H1-GATE-06 Storage final-component symlink escape is rejected
- AUTH-H1-GATE-07 `/me` 5xx/network failure is not interpreted as logged-out
- AUTH-H1-GATE-08 Existing multi-user isolation tests remain green
- AUTH-H1-GATE-09 Existing auth/login/bootstrap tests remain green
- AUTH-H1-GATE-10 No regression in current CI / verify / e2e

## Regression matrix

Existing suites that must stay green untouched except where the contract
deliberately changed (logout 401→204, bootstrap "created"→noop,
AuthContext boot-error anonymous→error):

- `backend/test/integration/auth.test.ts` (logout + rate-limit-user setup updated)
- `backend/test/integration/auth-isolation.test.ts`, `auth-migration.test.ts` (untouched)
- `backend/test/unit/storage.test.ts` (extended, existing cases unchanged)
- `frontend` vitest suites, Playwright e2e, `scripts/verify.sh`
