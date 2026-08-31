# AGENTS.md

## 1. Purpose

This file defines the agent workflow and project-level engineering constraints for **PersonalPlatform**.

Detailed implementation rules are intentionally kept in the project documentation:

- App development contract: `doc/APP_DEVELOPMENT.md`
- General development and test workflow: `doc/DEVELOPMENT.md`
- Migration operations: `doc/MIGRATION_RUNBOOK.md`
- Architecture: `doc/PERSONAL_PLATFORM_INITIAL_DESIGN.md`
- Phase/task plans: `doc/worklists/`

Do not duplicate those documents here.

---

## 2. Project State

PersonalPlatform is a:

> single-user, self-hosted modular monolith.

The platform base is frozen at:

```text
App Contract V1
platformApiVersion = 1
```

Default development direction:

> Add or improve Apps without modifying Platform Core.

Existing Apps must remain independently usable and lifecycle-safe.

---

## 3. Frozen Boundary

Treat the following as frozen unless a task explicitly requires a platform-level change:

```text
backend/src/core/
migrations/core/
App Contract V1 semantics
platformApiVersion
app lifecycle
capability model
schema isolation
migration ownership model
event/scheduler owner isolation
```

For normal App work:

```text
apps/<id>/
backend/src/apps/<id>/
frontend/src/apps/<id>/
app-specific tests
```

should contain the majority of changes.

Generated registry changes are expected when Apps are added or removed.

Generic shared UI changes are allowed only when:

- the abstraction is genuinely reusable;
- no App-specific semantics leak into shared code;
- regression tests are added where appropriate.

If a task appears to require changing the frozen boundary, stop that part of implementation and escalate it to the architect.

Do not silently evolve Contract V1.

---

## 4. Agent Roles

Use the configured subagents according to task complexity.

### architect

Responsible for:

- repository/context review;
- architecture decisions;
- identifying frozen-boundary risks;
- defining migration/API/data-model strategy;
- producing the phase/task worklist.

Architect should not perform broad implementation unless necessary.

### worker

Use for routine implementation:

- frontend components;
- straightforward CRUD;
- documentation;
- tests;
- small scripts;
- isolated refactors.

Keep worker context scoped to its task.

### advanced-worker

Use for higher-risk work:

- migrations;
- concurrency;
- transaction semantics;
- complex SQL/filtering;
- lifecycle-sensitive behavior;
- recovery/state-machine logic;
- cross-layer changes.

### reviewer

Used as an implementation checkpoint.

Reviewer should independently verify:

- proposed architecture;
- scope;
- correctness assumptions;
- acceptance criteria;
- regressions;
- unnecessary Core/shared changes.

Reviewer should prefer reading the worklist and relevant diff rather than re-reading the whole repository.

### final-reviewer

Must be independent from the primary implementation path.

Responsible for final batch acceptance only.

Final review should verify the actual repository state, not rely solely on worker summaries.

---

## 5. Standard Workflow

For non-trivial work, use:

```text
1. inspect
2. architect
3. freeze worklist
4. reviewer checkpoint
5. implementation
6. task-level tests
7. regression tests
8. full canonical gates
9. final-reviewer
10. commit / push / CI
```

Do not begin broad implementation before the worklist checkpoint passes.

Small isolated bug fixes may skip the full architecture phase when the scope and root cause are obvious.

---

## 6. Worklists

Non-trivial phases or features should create:

```text
doc/worklists/<NAME>_WORKLIST.md
```

A worklist should contain only what is needed to execute and verify the work:

- objective;
- current gap;
- architecture/data-model decision;
- task breakdown;
- dependencies;
- allowed file scope;
- explicit non-goals;
- acceptance criteria;
- regression matrix.

Avoid repeating large amounts of project background.

Once implementation begins, treat the approved worklist as frozen unless a discovered fact invalidates it.

If changed, record why.

---

## 7. App Development

For new Apps, always begin with:

```bash
npm run create:app -- <id> "<Name>"
```

Then follow:

`doc/APP_DEVELOPMENT.md`

Default expectation:

```text
create app
→ implement inside app slice
→ generate/check
→ test
→ verify
```

Adding a normal App should not require Platform Core modification.

Use:

- `_template` as the minimal Contract V1 example;
- `focus` as the full reference implementation.

Do not add capabilities that the App does not use.

---

## 8. Database and Migrations

All migrations are forward-only.

Never modify an already-applied migration to change shipped behavior.

For App migrations:

```text
apps/<id>/migrations/
```

Apps own only their schema.

Do not access or mutate another App's tables directly unless a future platform contract explicitly introduces such behavior.

For structural migrations, test both:

- fresh installation;
- upgrade from the previous schema/data state.

Data-preserving migrations require explicit regression coverage.

---

## 9. Time Semantics

Calendar/local-day logic must use Platform TimeService.

Do not derive user-local "today" from:

```sql
CURRENT_DATE
```

or system timezone assumptions.

Use:

```text
ctx.time
```

and existing project conventions.

Timezone-sensitive functionality should include boundary/DST regression tests where relevant.

---

## 10. Events and Compatibility

Event names are versioned contracts.

Do not silently change the payload semantics of an existing:

```text
*.v1
```

event.

If a semantic breaking change is required, introduce a new event version or explicitly retire the old event after confirming consumers.

Do not declare events capability without an actual use case.

---

## 11. Testing Expectations

Tests should target semantics, not only implementation paths.

Important cases include:

- nullable/three-state PATCH behavior;
- invalid references;
- transaction rollback;
- reload/persistence;
- lifecycle enable/disable;
- migration upgrade;
- timezone boundaries;
- concurrent mutation when applicable;
- URL/deep-link persistence;
- E2E user-visible workflows.

When a bug is discovered during implementation or review:

> add a regression test before declaring it fixed.

Avoid brittle tests that depend on:

- exact total App count;
- persistent local database residue;
- timing accidents;
- unrelated UI text.

---

## 12. Canonical Gates

Before final acceptance, run the repository's canonical checks.

At minimum, currently expect:

```bash
npm run check
npm run build
npm test
npm run test:integration
npm run e2e
./scripts/verify.sh
git diff --check
git status
```

Use the actual current scripts documented by the repository if they change.

A phase is not complete until:

```text
local gates PASS
final-reviewer ACCEPTED
working tree clean
GitHub Actions success
```

---

## 13. Git Hygiene

Prefer small, coherent commits.

Do not commit:

- debug logging;
- temporary Apps;
- generated test artifacts;
- local database files;
- screenshots unless intentionally part of documentation;
- stale generated registries;
- unrelated formatting changes.

Before finalizing:

```bash
git diff --check
git status
```

must be clean/expected.

---

## 14. Scope Discipline

Do not opportunistically refactor unrelated code.

If an unrelated defect is found:

- fix it only when it blocks the current task or is an obvious low-risk correctness issue;
- otherwise record it for a separate batch.

Do not combine unrelated Apps or platform maintenance in the same implementation batch unless the worklist explicitly defines them together.

Prefer serial, independently accepted batches.

---

## 15. Review Standard

Reviewer and final-reviewer should actively look for:

- silent data loss;
- migration compatibility problems;
- timezone mistakes;
- stale-client/concurrency issues;
- App Contract violations;
- hidden Core coupling;
- duplicated infrastructure;
- broken disabled-App behavior;
- UI interaction conflicts;
- tests that pass for the wrong reason.

Do not accept a feature solely because the happy path works.

---

## 16. Token / Context Efficiency

Avoid having every subagent read the entire repository.

Recommended pattern:

```text
scout/architect
→ identify relevant files
→ task-scoped workers
→ diff-scoped reviewer
→ independent final review
```

Reuse approved worklists and existing project documentation as context.

Do not duplicate the same repository audit across multiple agents unless independence is required for final verification.

---

## 17. Default Decision Rule

When choosing between:

```text
modify Platform
```

and:

```text
solve inside the App
```

prefer the App-local solution unless it would create a genuine platform-wide invariant or reusable primitive.

The default engineering direction after Platform V1 freeze is:

> build on the platform, not rebuild the platform.