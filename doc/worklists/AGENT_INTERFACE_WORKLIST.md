# AGENT_INTERFACE_WORKLIST

Unified Agent Interface (Platform + Apps, MCP Streamable HTTP + Structured HTTP/JSON, Multi-User Consent) — Batch 2.

> Prerequisite: **Batch 1 accepted and merged** in [PR #1](https://github.com/AmazingUmi/PersonalPlatform/pull/1), commit `76d8e0f`.
> Status: **A1–A9 IMPLEMENTED**. A10 records the local gates and independent review below.

---

## 1. Objective

Provide a dedicated, first-class, Agent-oriented interface pointing to both **Platform Core** (read-only introspection & cross-app overview) and **installed Apps** (semantic read/write/soft-delete tools & read-only resources), optimized for LLM context efficiency, concurrency safety, and multi-user VPS deployment.

Hard invariants:
1. **Strict identity & consent boundary**: An Agent is a first-class entity that can bind to one or multiple users, **only after each target user explicitly authorizes it** with per-user scopes (`read` / `write` / `delete`) and per-user allowed App list. User A's grant never permits reading or mutating User B's data.
2. **Blast-radius isolation**: Agent Bearer credentials authenticate only `/api/agent/*`. Existing Core and browser App routes, including Agent management, keep their Cookie authentication semantics.
3. **Zero irreversible deletion**: Agent `delete` operations **always** route through Batch 1 Unified Trash (tagged with `deleted_by_type = 'agent'`) and never expose permanent purge.
4. **App modularity & lifecycle parity**: Apps declare their own Agent tools/resources inside `backend/src/apps/<id>/` via an additive optional Contract V1 hook (`platformApiVersion = 1` unchanged). Disabled Apps immediately vanish from Agent discovery and reject tool invocation. Core never queries App schemas directly.
5. **Concurrency safety**: Mutations of existing records compare a required `baseHash` under the App's transaction and WebDAV lock order. Only an authorized reader receives a current snapshot on conflict.

---

## 2. Current Gap

- Authentication (`backend/src/core/auth/`) is exclusively browser Cookie-based (`pp_session`); external MCP clients and Agent runtimes on a VPS cannot authenticate without unsafe cookie hacks.
- Existing `/api/apps/*` routes are UI-shaped CRUD endpoints without pagination/projection defaults, semantic composite actions, cross-app overview, or MCP protocol support.
- There is no multi-user Agent consent/grant model, no per-App permission allowlist for external automation, and no user-visible Agent activity audit log.
- `docker/nginx.conf` proxies `/api` with default buffering, which needs `proxy_buffering off` for MCP Streamable HTTP SSE responses.

---

## 3. Architecture & Data-Model Decisions

### AD-1 Unified Capability Layer & Dual Protocol Surface

New Core module `backend/src/core/agent/`:
- One registry defines tool schemas, action kinds, required scope sets, ownership, MCP annotations and handlers. It also defines read-only resources with a URI, MIME type, owner and reader. Both transports dispatch through the same registry and authorize every request against the current grant.
- Serve both transports under `/api/agent/` through the VPS HTTPS reverse proxy and container Nginx.
  1. **MCP Streamable HTTP** at `/api/agent/mcp` targets revision [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Implement [`initialize` and `notifications/initialized`](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), the negotiated protocol-version header, content negotiation, `ping`, `tools/list`, `tools/call`, `resources/list`, and `resources/read`. Support JSON replies and bounded request-scoped SSE over POST. Use the stateless transport option without `MCP-Session-Id`, standalone SSE or resumption. GET and DELETE return `405` for authenticated requests with valid Origin. Advertise only implemented capabilities. Document a versioned client configuration after testing it against the deployed endpoint.
  2. **Structured HTTP/JSON Discovery & Invoke**:
     - `GET /api/agent/v1/manifest` — returns Agent identity, selected user, effective scopes, enabled and allowed Apps, tool schemas, and resource URIs. The acting-user selection error lists only active grants for this Agent.
     - `POST /api/agent/v1/tools/:toolName` — invokes a tool directly with JSON body and returns the uniform structured result envelope.
     - `GET /api/agent/v1/resources?uri=...` — reads a declared resource.
- **Operational controls**
  - `AGENT_API_ENABLED` defaults to `true`. When disabled, the Agent ingress responds with `404` before credential lookup. Cookie-authenticated management and scheduled cleanup remain available. Validate and document the switch, Origin allowlist and audit retention settings in local and runtime Compose configurations.
  - Validate any supplied MCP `Origin` against explicit trusted origins (`AGENT_API_ALLOWED_ORIGINS`). An invalid Origin returns `403` on every MCP method. Requests without Origin still require Bearer authentication. Set `Cache-Control: private, no-store` for Agent data and discovery, advertise no catalog change notifications, and document how to refresh a host's tool cache after grant or App changes. Authorization is evaluated even when a client invokes a cached tool.
  - Apply a bounded pre-authentication IP limit and a separate authenticated sliding-window limit keyed by `(agent_id, client_ip)`. Reuse `TRUST_PROXY` semantics. Rate-limit pairing preview and approval per browser user and IP, and generation per owner. Keep plaintext tokens, pairing codes and submitted tool content out of logs.
  - Add an exact-match `/api/agent/mcp` block to `docker/nginx.conf` with `proxy_buffering off`, `proxy_cache off`, `chunked_transfer_encoding on` and a read timeout covering the bounded request. Preserve the existing forwarded-header rules and test the deployed reverse proxy path.

**A1 transport choice.** Pin `@modelcontextprotocol/sdk` to `1.32.2` and use its low-level Server and WebStandard Streamable HTTP transport. The Fastify ingress supplies the pre-auth policy, single-message checks, revision negotiation, and response headers. An initialize request that proposes another valid revision receives the supported `2025-11-25` version. Subsequent requests require the negotiated version header. The low-level server advertises tools and resources without catalog notifications. A localhost Fastify 5.12.7 wire fixture verified Inspector 2.16.0 in legacy mode and SDK Client 1.32.2. Both sent Bearer and acting-user headers on handshake, discovery, resource read, and invocation. They continued after a 405 response to the optional GET probe. The fixture verified `2025-11-25`, JSON and SSE, no session identifier, an early SSE frame, and final close. Repeat these tests on the actual platform endpoint and through Nginx in A8. VS Code remains a candidate for a published editor configuration after an actual host run. [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) · [Inspector CLI](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md)

### AD-2 Multi-User Agent Entity, Explicit Consent & Acting-User Resolution

New forward-only Core migration `migrations/core/<timestamp>-agent-interface.sql`:

1. `core.agents`:
   - `id uuid PRIMARY KEY`
   - `name text NOT NULL` (1–64 chars)
   - `description text NOT NULL DEFAULT ''`
   - `created_by_user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE`
   - `token_hash text NOT NULL UNIQUE` (sha256 hex of 32-byte random base64url token; plaintext shown once on creation/rotation)
   - `token_prefix text NOT NULL` (short display fragment for UI identification)
   - `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked'))`
   - `requires_explicit_actor boolean NOT NULL DEFAULT false` (set on first secondary-user approval, retained after grant expiry, revocation and token rotation)
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - `last_used_at timestamptz`
2. `core.agent_user_grants`:
   - `id uuid PRIMARY KEY`
   - `agent_id uuid NOT NULL REFERENCES core.agents(id) ON DELETE CASCADE`
   - `user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE`
   - `scopes text[] NOT NULL` (non-empty subset of `['read', 'write', 'delete']`)
   - `allowed_apps text[] NOT NULL` (explicit allowlist of App IDs; `'platform'` read is always implied by `'read'`)
   - `expires_at timestamptz` (nullable = no expiration)
   - `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked'))`
   - `granted_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - `revoked_at timestamptz`
   - `UNIQUE (agent_id, user_id)`
3. `core.agent_pairing_requests`:
   - `id uuid PRIMARY KEY`
   - `agent_id uuid NOT NULL REFERENCES core.agents(id) ON DELETE CASCADE`
   - `code_hash text NOT NULL UNIQUE` (sha256 hex of a cryptographically random one-time pairing code with at least 128 bits of entropy)
   - `requested_scopes text[] NOT NULL`
   - `requested_apps text[] NOT NULL`
   - `created_by_user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE`
   - `expires_at timestamptz NOT NULL` (short TTL, e.g. 15 minutes)
   - `consumed_by_user_id uuid REFERENCES core.users(id) ON DELETE SET NULL`
   - `consumed_at timestamptz`
   - `created_at timestamptz NOT NULL DEFAULT now()`
4. `core.agent_audit_logs`:
   - `id uuid PRIMARY KEY`
   - `agent_id uuid REFERENCES core.agents(id) ON DELETE SET NULL`
   - `agent_name text NOT NULL` (snapshot preserved even if Agent deleted)
   - `user_id uuid NOT NULL REFERENCES core.users(id) ON DELETE CASCADE`
   - `app_id text NOT NULL`
   - `tool_name text NOT NULL`
   - `action_kind text NOT NULL CHECK (action_kind IN ('write', 'delete'))`
   - `resource_id text`
   - `status text NOT NULL CHECK (status IN ('ok', 'replayed', 'conflict', 'denied', 'error'))`
   - `error_code text`
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - Index `(user_id, created_at DESC, id DESC)` for personal cursor pagination and `(created_at)` for retention cleanup.
5. `core.agent_create_receipts` keeps the acknowledgement needed after a lost create response. Its unique key is `(grant_id, tool_name, idempotency_key)`. It stores a fingerprint of the validated, normalized tool arguments and the created entity ID. The grant foreign key cascades on removal. Receipts survive token rotation and audit cleanup for the lifetime of their grant row.

**Creation, consent and revocation**

- A signed-in user explicitly selects the Apps, scopes and optional expiry for their own personal Agent. Create the Agent and creator grant in one transaction, then return the Bearer token once.
- Only the signed-in Agent owner issues pairing codes. The signed-in recipient previews the Agent, owner and requested permissions in Settings and explicitly approves their own grant. The preview explains that the owner controls the credential and that a rotated credential retains their grant. The server validates supported scopes and App IDs and enforces that approval stays within the requested scopes and Apps. The pairing lifetime bounds the approval window. The chosen grant expiry bounds subsequent access.
- In one transaction, validate the active Agent, claim an unconsumed, unexpired code, create or reactivate the recipient's grant and set `requires_explicit_actor` for a secondary user. A failed approval rolls back the claim. An active grant stays authoritative. An expired or revoked grant requires a fresh code issued after its expiry or revocation. Serialize grant changes with approval and invalidate outstanding codes when globally revoking the Agent.
- A grant holder may narrow their own scope and App sets, shorten expiry, or revoke. To broaden a paired grant or extend its validity, revoke it and approve a fresh code. The creator can create a new personal Agent with broader consent. An Agent owner can rotate or revoke the credential globally. Owner rights over the Agent never confer management rights over another user's grant.

**Acting user and authorization**

- Resolve the Bearer token against an active Agent. Invalid, rotated and revoked credentials return `401`. Match grants only for active users and evaluate expiry using the platform clock. A valid Agent with no active grants returns `403 no_active_grant`. An explicit actor without an active grant returns `403 forbidden`.
- Before any secondary-user approval, an omitted selector may resolve only to the creator with an active grant. Once `requires_explicit_actor` is set, every data or discovery request requires a selector even if one active grant remains. A missing selector returns `400 acting_user_required` with only the authorized usernames. Check this independently of protocol handshake or connection state.
- Use `X-PP-Acting-User: <username>` across MCP discovery, tool calls and resource reads. The Settings snippet for a paired Agent selects a user for the host configuration. Advertise multi-user MCP only for verified hosts that send the configured header on every relevant request. JSON accepts the same header, with `actingUser` on manifest/resource queries or `_actingUser` on tool calls as alternatives. Reject duplicate, malformed or disagreeing selectors. Strip the JSON gateway selector before tool-schema validation and resolve to one immutable user ID for the request.
- Use one authorization lock order for invocation and management (Agent → acting user → pairing code if applicable → grant). Under the Agent lock, recheck the credential and resolve the retained request selector against the current `requires_explicit_actor` flag. Under the user and grant locks, confirm active status, expiry and effective permissions before admitting the request. Acquire the App's existing data locks after them for a mutation. Authorization read locks must conflict with ordinary updates that change authority. Hold those locks until a read result is fully materialized or the mutation transaction finishes. Update optional usage timestamps outside that transaction to avoid upgrading its authorization locks. A revoke, scope reduction or token rotation either waits for an admitted operation or wins before authorization and prevents that operation. After the change commits, an already-authorized result may still arrive, including over SSE. Every new read or write requires a fresh authorization decision. An existing stream only delivers already-materialized data. Apply the same rule to discovery and create receipt replay, and bound the lifetime of admitted operations.

Apply the shared attachment reader guard before authorization where an Assets operation will read or stage bytes. Pairing first finds a candidate Agent from the hashed code and rechecks the code and grant after locking Agent and recipient. Management mutations recheck the Cookie session under its owner lock. Accept only a fresh code for an expired or revoked grant. If an account cascade or another transaction wins admission, roll back and return an authorization or retryable datastore result according to the resulting state.

### AD-3 Additive App Contract V1 Extension (`platformApiVersion = 1` unchanged)

Add `registerAgent?(ctx: AppAgentContext): Promise<void>` to `BackendAppModule`. The App registers `<appId>_` tools, `pp://apps/<appId>/...` resources and an optional read-only overview provider. Core validates definitions and tool arguments. Keep App queries and semantics in their App. Invocation provides the resolved `userId`, the App's allowed facilities and transaction-bound data access. Agent handlers and browser routes share App-owned operations. The Agent invocation never creates a browser session or borrows privileges from the acting user's browser role.

- Publish an App's Agent definitions together only after migration, App activation and completed registration. Stage them per activation generation. Dropping an App or failing activation discards that generation and invalidates its pending registrations. A late async completion cannot publish after disable or supersede a successful re-enable.
- Require the App's current runtime status to be `enabled` and its Agent registrations to be ready for the current generation. Check this, the selected grant's `allowed_apps`, and all required scopes for discovery, resource reads, overview aggregation and direct tool invocation. A retained or cached tool name cannot bypass this check. A request admitted before deactivation may finish, and new admissions stop when the App is deactivated.
- Keep resource readers, overview providers and read tools free of durable mutations and event publication. Use the same scope and owner checks on direct `resources/read` and `platform_overview` as on resource discovery.
- Existing-entity writes require `read` and `write`. Deletes require `read` and `delete`. A standalone create such as `tasks_create` or `clock_alarm_create` requires `write` and returns only the created ID. `notes_create` and `assets_create` also require `read` because they accept existing tag or category references. `focus_start` requires `read` for the timer state proof. Tool visibility and handler admission both enforce the full scope set. A `write`-only or `delete`-only grant receives no existing-entity data through a mutation result, validation failure or conflict. Audit `action_kind` remains the action performed (`write` or `delete`).

### AD-4 Semantic Tool Catalog, Token Optimization & Concurrency Contract

**Platform-level Tools & Resources (Read-Only)**:
- `platform_status` — platform name, environment, timezone, server time (via `ctx.time`), authenticated Agent & acting user summary.
- `platform_list_apps` — enabled & grant-permitted Apps with descriptions and available tool count.
- `platform_overview` — aggregated snapshot across enabled & permitted Apps (e.g., today's due/overdue tasks, active focus timer, upcoming alarms, recent notes count/titles, asset summary count) using each App's overview provider and `ctx.time` local-day semantics.
- Resources: `pp://platform/overview`, `pp://platform/apps`.

**Core Productivity App Tools (First Wave)**:
- **`tasks`**:
  - `tasks_list` (paginated `limit` default 20 / max 100, `offset`, filters `q`, `status`, `priority`, `dueBefore`/`dueAfter`, concise projection excluding long description unless `includeDescription: true`)
  - `tasks_get` (full item + `baseHash`)
  - `tasks_create`
  - `tasks_update` (requires `baseHash`)
  - `tasks_complete` (semantic shortcut to mark done/todo; requires `baseHash`)
  - `tasks_delete` (requires `baseHash`; moves to Unified Trash with Agent attribution)
  - Resource: `pp://apps/tasks/summary`
- **`notes`**:
  - `notes_list` (paginated, filters `q`, `tag`, `mood`, `pinned`; returns title + short content snippet by default, `includeContent: false` to protect LLM context)
  - `notes_get` (full Markdown content + tags + `baseHash`)
  - `notes_create`
  - `notes_update` (requires `baseHash`)
  - `notes_delete` (requires `baseHash`; moves to Unified Trash with Agent attribution)
  - `notes_tags_list`
  - Resource: `pp://apps/notes/summary`
- **`assets`**:
  - `assets_list` (paginated, filters `q`, `categoryId`, concise projection)
  - `assets_get` (full item + categories + attachment metadata `[id, filename, contentType, size]` — no binary base64 blobs + `baseHash`)
  - `assets_create`
  - `assets_update` (requires `baseHash`)
  - `assets_delete` (requires `baseHash`; moves item + attachments to Unified Trash with Agent attribution)
  - `assets_categories_list`
  - Resource: `pp://apps/assets/summary`
- **`focus`**:
  - `focus_state` projects the current timer and remaining/elapsed time via `ctx.time` and returns its state proof. When a session has naturally expired, compute its effective state in memory. Keep the existing browser `/state` reconciliation and scheduler behavior.
  - `focus_start` requires a matching `baseHash` for the observed no-active state and an idempotency key. Include the relevant stored session proof and settings when computing the state proof. `focus_pause`, `focus_resume` and `focus_stop` require the expected session ID and matching `baseHash` even on idempotent transition paths. Verify those guards under the App's data locks before any state changes. A stale or rejected Agent transition rolls back incidental expiry reconciliation and publishes no event.
  - `focus_stats` (summary over N days)
  - `focus_sessions_list` (paginated recent history)
  - Resource: `pp://apps/focus/summary`
- **`clock`**:
  - `clock_overview` (platform timezone time + world clocks + enabled alarms)
  - `clock_alarms_list`, `clock_alarm_create`, `clock_alarm_update` (requires `baseHash`), `clock_alarm_delete` (requires `baseHash`; moves to Unified Trash)
  - `clock_world_clocks_list`
  - Resource: `pp://apps/clock/summary`

**Mutation, conflict and retry**

- Require a valid `baseHash` for the specified operations even when WebDAV sync is off. Within the authorized transaction, preserve the App's existing table, owner and row lock order, then compare against the same canonical proof the App exposes and preserve the App's `syncWriteFenced` checks. A missing or malformed proof is a validation error. A stale proof returns `code: "conflict"`, a retry hint and the authorized current snapshot with its `baseHash`. If the target is absent, return a scoped not-found or no-active result without disclosing another user's record or redirecting to a restored record with a fresh ID.
- HTTP/JSON maps `conflict` to `409`. MCP returns an actionable [`tools/call` execution error](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling) with `result.isError = true` and equivalent structured data. Keep authentication, transport and JSON-RPC errors distinct from authorized tool execution results.
- Core opens the outer transaction for authorization, the App mutation, any Batch 1 Trash row and the successful audit entry. For an asset deletion with attachments, first authorize the preparation and commit its Batch 1 staging intent. The outer transaction then rechecks authorization, claim and source identity before the first file write. The App gets that transaction and uses Batch 1 recovery for attachment work. Core supplies the verified Agent ID/name and actor for Trash attribution. Accept no attribution values from tool arguments.
- Events representing App mutations are deferred until the outer transaction commits, including completion events from tasks and Focus. Keep existing event names, versions and payloads. A rollback discards deferred events, including when the successful audit write failed. A post-commit delivery failure is logged and does not change the committed mutation result. An SSE response can start with a transport frame while the tool runs. Send the tool result only after the transaction finishes.
- Every create takes a UUID `idempotencyKey` and stores its receipt in the same transaction as the mutation and successful audit. Replays authenticate and authorize afresh. The same grant, tool and key with matching arguments returns the prior ID and records `replayed` without running the App operation again, even after token rotation. Different arguments with the same key return `idempotency_conflict` without a record snapshot. A rolled-back attempt has no receipt and can be retried. Concurrent duplicate calls converge on one mutation. The recorded ID refers to the original create even if the entity was subsequently deleted or restored as a new record.

**Audit logging and retention**

- Record successful writes/deletes in their mutation transaction. Record attributable conflicts, denials and errors in a separate transaction after rollback. If that attempt cannot be persisted, log a sanitized diagnostic and preserve the original failure result. Only a verified acting user with an active grant at the authorization decision can receive a user-visible audit entry. Invalid credentials, missing actors and unauthorized actor selections use operator diagnostics without trusting the submitted username as an audit subject. Store stable action metadata, an optional authorized resource ID and an error code, with no tool content or credentials.
- The Core Scheduler removes audit entries older than `AGENT_AUDIT_RETENTION_DAYS` (default 90, integer 1–365) in bounded, retryable batches. Use the platform clock, a stable cutoff per sweep and the cleanup index. Pairing code cleanup removes expired rows after the approval window and relies on `consumed_at` until expiry to prevent reuse. Keep retention jobs available while Agent ingress is disabled.
- Users query their own audit entries via Cookie-authenticated `GET /api/core/agents/audit`, with bounded cursor pagination ordered by `(created_at, id)`.

Reserve a create receipt by taking a transaction-scoped advisory lock on the grant, tool and idempotency key before looking up the exact receipt. A successful create writes the receipt with its final entity ID. An uncertain commit does not authorize event publication. Check the settled receipt or attachment intent when available and return an explicit outcome-unknown error when the commit cannot be established.

### AD-5 Management API & Settings UI

Cookie-authenticated Core management routes (`/api/core/agents/*`)

- `GET /api/core/agents` — list Agents owned by current user + Agents currently authorized by current user.
- `POST /api/core/agents` — create personal Agent with the creator's explicit grant and return one-time Bearer token.
- `POST /api/core/agents/:id/rotate-token` — owner replaces the token and receives the new token once. The old token loses authority when the replacement commits.
- `DELETE /api/core/agents/:id` — owner revokes the Agent globally and invalidates pending pairing codes.
- `POST /api/core/agents/:id/pairing-codes` — owner generates short-lived pairing code for multi-user consent.
- `POST /api/core/agents/pairings/preview` — target user previews pairing code (Agent name, owner display name, requested scopes & Apps) before approving.
- `POST /api/core/agents/pairings/approve` — target user explicitly approves pairing code with chosen (optionally narrowed) scopes, allowed Apps, and optional expiration.
- `PATCH /api/core/agents/grants/:grantId` — user narrows own grant's scopes / allowed Apps / expiry under AD-2.
- `DELETE /api/core/agents/grants/:grantId` — user revokes own grant immediately.
- `GET /api/core/agents/audit` — cursor-paginated Agent write/delete activity log for current user.

Resolve the management principal through the existing Cookie guard. Apply owner checks to Agent changes and user checks to grant changes and audit queries. The API validates requested expiry and scope changes against stored values inside the authorization transaction. Public existing endpoints keep their existing unauthenticated semantics.

Frontend

- Add **Agents** panel in `frontend/src/shell/Settings.tsx` (`AgentsPanel.tsx`):
  - Create a personal Agent after showing and confirming its scopes and App list. Show the token once and offer a tested MCP client snippet pointing to the current origin's `/api/agent/mcp`. Keep plaintext tokens out of browser persistence and URLs.
  - Generate and enter pairing codes to review and approve another Agent. Submit pairing codes in request bodies.
  - Show effective permissions, grant expiry, narrowing and revocation. Explain how to reauthorize and how a paired MCP configuration chooses an acting user.
  - View personal Agent activity and display the same actor labels used in Trash.

---

## 4. Task Breakdown & Dependencies

| Task | Depends on | Owner Role | Work |
|---|---|---|---|
| A1 | Batch 1 accepted and merged | architect + reviewer | Verify the Batch 1 transaction, attribution and restore contracts. Choose the MCP implementation for `2025-11-25`, confirm a candidate host supports the required headers and freeze this worklist after reviewer approval |
| A2 | A1 | advanced-worker | Forward-only Core migration, Agent credential service, atomic pairing and grant management, authorization locks, activity retention and create-receipt storage |
| A3 | A2 | advanced-worker | Registry and optional Contract V1 hook, generation-safe lifecycle, scope enforcement and transaction-bound dispatch including audit, create replay and deferred App events |
| A4 | A3 | advanced-worker | MCP and JSON transports, `platform_*` tools/resources, ingress limits and configuration, Origin validation, Compose variables and Nginx streaming |
| A5 | A3 | worker / advanced-worker | First-wave App registrations and shared App operations, read-only overview, concurrency proofs and Trash-routed deletes |
| A6 | A2 | worker | Cookie-authenticated `/api/core/agents/*` routes, consent and owner checks, pairing limits, and audit pagination |
| A7 | A6, A4 (verified snippet) | worker | Frontend `Settings → Agents` (`AgentsPanel.tsx`: create, one-time token copy, MCP config snippet, pairing code create/approve, grant editor/revoke, activity audit log) + i18n |
| A8 | A4, A5, A6, A7 | advanced-worker / worker | Verify the regression matrix with unit and integration tests, fresh and upgraded DBs, a real MCP host, Docker/Nginx and Playwright |
| A9 | A8 | worker | Concise documentation updates (`README.md`, `doc/DEPLOYMENT.md`, `doc/APP_DEVELOPMENT.md` additive `registerAgent?` section) |
| A10 | A9 | final-reviewer | Run canonical gates (`check`, `build`, `test`, `test:integration`, `e2e`, `test:docker:config`, `verify:docker`, `./scripts/verify.sh`, `git diff --check`, `git status`). Independently review the resulting diff and verify GitHub Actions and clean state at acceptance |

### Preflight for A1 (2026-11-25)

- The existing Fastify App routes have separate lifecycle and Cookie guards. Keep the Bearer ingress and Cookie management in separate encapsulated routes. Review route-local error handling because the global handler logs raw error details. Bound the Agent limiter's cardinality and derive its IP from the existing proxy trust configuration.
- Verify the merged Trash transaction boundary against Agent authorization, audit and attachment staging before starting A2. App tools must use the authorized transaction context. Tasks and Focus currently publish events after their browser transactions. Defer Agent-side events until the outer transaction commits. Review that authorization reads conflict with ordinary authority updates, including non-key changes, and route the user status lock through Core Auth. Check lifecycle generation before publishing a tool catalog.
- A1 will select a server implementation after verifying revision `2025-11-25`, JSON and request-scoped SSE, and acting-user header propagation through a real host. VS Code documents custom MCP headers and is a candidate. Host interoperability and grant races remain open. [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- Settings keeps visited panels mounted. Clear one-time credentials when the user leaves Agents or changes accounts. Apply `Cache-Control: private, no-store` to responses that carry plaintext tokens or pairing codes.

---

## 5. Allowed File Scope

- `migrations/core/` (new forward-only migration only)
- `backend/package.json`, `package-lock.json` (only if MCP SDK dependency is approved in A1)
- `backend/src/core/agent/` (new module)
- `backend/src/core/auth/service.ts` and `backend/src/core/trash/service.ts` (narrow active-account, Cookie-session, and transaction/recovery adapters for the Agent dispatcher)
- `backend/src/core/app-registry/types.ts`, `context.ts` (additive `registerAgent?`)
- `backend/src/core/platform.ts`, `backend/src/core/config/index.ts` (wire Agent gateway and activation, configure ingress and retention)
- `backend/src/apps/{tasks,notes,assets,focus,clock}/` (co-located `registerAgent` definitions; no cross-app imports)
- `docker/nginx.conf`, `docker/docker-compose.runtime.yml`, `docker-compose.yml`, `.env.example`, `.env.production.example`, `.env.release.example` (streaming proxy and Agent configuration)
- `frontend/src/shell/Settings.tsx`, `frontend/src/shell/AgentsPanel.tsx`, `frontend/src/shell/settings.css` (Agent panel styles scoped to its existing Settings stylesheet), `frontend/src/shared/i18n.tsx`
- `backend/test/`, `frontend/src/**/*.test.*`, `frontend/e2e/`, `scripts/test/`
- `README.md`, `doc/DEPLOYMENT.md`, `doc/APP_DEVELOPMENT.md`, `doc/worklists/AGENT_INTERFACE_WORKLIST.md`

---

## 6. Explicit Non-Goals

- Preconfigured Bearer authentication only. OAuth discovery, OAuth enrollment, modern `2026-07-28` MCP, and older MCP transport revisions are outside this batch.
- Pairing and credential management remain browser operations. The Agent interface covers invocation and discovery.
- No Platform admin mutations via Agent (no enabling/disabling Apps, no user account creation, no WebDAV/snapshot restore, no permanent Trash purge).
- No binary attachment upload/download through MCP JSON payloads (Assets attachments are metadata-only in v1).
- No `mini_game` gameplay tools in v1 (module remains untouched, verifying backward compatibility of optional `registerAgent?`).
- No removal of Docker or changes to `scripts/deploy.sh` state machine.

---

## 7. Acceptance Criteria & Regression Matrix

| Area | Required Verification |
|---|---|
| Migration and configuration | Fresh and Batch 1 upgrade installs succeed and existing users, App data and Trash entries survive. Development, production source and release Compose each pass through ingress, Origin and audit-retention settings. Malformed config fails validation |
| MCP protocol | Test negotiation, `notifications/initialized` `202`, protocol-version validation, JSON and SSE, authenticated GET/DELETE `405`, and rejected invalid Origin. A recorded real-host version completes the lifecycle, discovers, reads resources and invokes a tool. Verify common schemas and domain results across transports with each transport's native error envelope |
| Single-user binding | User consents to a personal grant and sees the token once. Omitted actor selects the creator while active. Invalid and revoked tokens, including an old token after rotation, return `401`. Grant expiry leaves a `403` authorization result for a still-valid token |
| Multi-user actor selection | A → A+B → B and A → A+B → A via revocation and expiry. Omitted actor keeps returning `acting_user_required` after first pairing. Explicit A never routes to B. Reject duplicate and contradictory selectors. A real paired MCP host sends its actor header on discovery and resource reads as well as invocation |
| Consent and owner checks | Preview creates no grant. Two concurrent approvals consume one code and create one grant. Rollback leaves the code reusable. Reject expired codes, scopes/Apps outside the request, expansions through PATCH, codes predating revocation and cross-user grant edits. Revoking the Agent invalidates pending codes |
| Authorization races | Hold a tool mutation, resource read and create replay at controlled barriers while another request narrows, revokes or rotates. Verify commit ordering, rejection of new requests and deferred reads after invalidation, and delivery of already-materialized output. Race expiry and first secondary-user approval against pending admission. If approval commits first, an omitted selector requires explicit selection |
| Scope and allowlist | Check discovery and direct calls/reads, including cross-App overview. Read-only cannot mutate. Standalone write-only create returns an ID. Write-only and delete-only cannot obtain existing data through mutation success, validation or conflict or probe tag/category references through create. Unauthorized IDs and cached names cannot bypass permissions |
| Blast-radius isolation | An Agent Bearer without a Cookie grants no access to protected browser App, Core auth/data/Trash or Agent management routes. Existing public logout remains `204`, a disabled browser App remains `404`, and Cookie behavior remains valid. Cookie alone cannot authenticate Agent ingress |
| Lifecycle and modularity | Disabling an App removes discovery, overview and resources and rejects direct invocation. Re-enable restores the current generation without restart. Inject a partial registration failure and race async registration with disable/re-enable. Only completed current definitions are visible. `mini_game` works without the hook |
| Safe delete and Trash | All four delete tools archive under the acting user with verified Agent ID and name. App row, Trash row and successful audit commit or roll back together. Restore in Settings recovers the entity under Batch 1's new ID. Old IDs and stale Agent retries leave the restored entity alone. No purge tool is exposed |
| Record concurrency and Focus | With sync off and with a WebDAV binding, omit, corrupt or stale a required `baseHash` while browser/remote edits occur. A correct retry can succeed. Read-only Focus at natural expiry makes no writes or events. A stale timer transition cannot reconcile the expiry or mutate a replacement session. Audit-insert rollback emits no completion event, while success preserves its `.v1` contract |
| Create replay | Race two equal create requests, simulate a lost reply after commit and retry after token rotation. All successful responses acknowledge the same ID. Different validated data with the same key conflicts. Audit failure rolls back state, receipt and deferred events. Revoked authority cannot replay |
| Projection and audit | Lists apply pagination limits, `notes_list` omits full Markdown by default and `assets_get` returns metadata only. User audit pagination stays stable across equal timestamps. Attributable failures, successful changes and replays are visible only to the acting user. Invalid actors create no user audit row. Retention removes only expired rows |
| VPS and Nginx | Disabled ingress returns `404` before credential lookup and management remains usable. Verify pre-auth, Agent and pairing limits with trusted and spoofed forwarding headers. Read an SSE event through Nginx before the tool finishes and verify the response closes after the result |
| E2E | Consent to a personal Agent in Settings, approve a second user, use MCP/HTTP for both users, review the per-user audit and Trash, then restore and revoke one grant |

---

## 8. Checkpoints

- Batch 1 (`UNIFIED_TRASH_WORKLIST.md`) Accepted: **PASSED**. [PR #1](https://github.com/AmazingUmi/PersonalPlatform/pull/1) merged at `76d8e0f` after [CI](https://github.com/AmazingUmi/PersonalPlatform/actions/runs/45583915433) passed. The merged tree matches the independently reviewed and locally verified candidate.
- The Continuous Sync test cleanup was independently verified and merged in [PR #2](https://github.com/AmazingUmi/PersonalPlatform/pull/2), commit `446950e`. It changes test database teardown only.
- Architect & Reviewer Checkpoint: **A1 PASSED**. Approved the pinned SDK, ingress negotiation and cache behavior, transaction lock order, and scoped Core adapters.
- A2–A7 Implemented. Each planned ingress, management, and App-supplied tool uses its existing lifecycle, scope and ownership boundaries.
- A8 Protocol Host: Inspector 2.16.0 in legacy mode connected to the platform over local HTTPS and Nginx using an isolated PostgreSQL database. It completed negotiation, discovery, resource reads and list/create calls as a paired user. The created Clock alarm belonged to the paired user. A direct SSE probe received data before the tool finished and closed after its result.
- A9 Documentation: Setup, proxy options, Inspector configuration and the additive App development contract are documented.
- A10 Local Canonical Gates: **PASSED**. The verification script completed with 272 backend unit tests, 602 frontend unit tests, 520 PostgreSQL integration tests and the backend smoke test. Chrome passed all 65 E2E cases. Compose configuration, release checks, actual production Compose startup and Git whitespace checks passed.
- A10 Independent Final Review: **ACCEPTED** for implementation and local verification. The release pull request records GitHub Actions and merge evidence.
