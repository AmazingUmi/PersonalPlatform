# New App

TODO: describe the app, then delete this line. Scaffolded by
`npm run create:app -- new_app "New App"`; the steps below make it work.

## Layout

```text
apps/new_app/               # app boundary: app.yaml (metadata source of truth), migrations/, README.md
backend/src/apps/new_app/   # backend module (default export BackendAppModule)
frontend/src/apps/new_app/  # frontend module (default export FrontendAppModule)
```

In `app.yaml`, fill in `description`, keep `frontend.route` under `/new_app`,
declare widget ids in `widgets`, and turn `capabilities` on only when used.

## Migration

Migrations are forward-only SQL files named `<YYYYMMDDHHMMSS>-<name>.sql`. The
runner creates the `new_app` schema and its `new_app.migrations` record table
automatically, so write bare table names without a schema prefix:

```sql
-- apps/new_app/migrations/20260101000001-init.sql
CREATE TABLE items (
  id uuid PRIMARY KEY,
  title text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Apply with `npm run migration:up`; in backend code, qualify tables as `new_app.items`.

## Backend module

`backend/src/apps/new_app/index.ts` default-exports a `BackendAppModule`.
Routes on `ctx.api` are relative to `/api/apps/new_app`. Validate input with
Fastify JSON Schema, throw `AppError` for domain failures; optional hooks:
`registerEvents` / `registerJobs` / `healthcheck` (see `backend/src/apps/tasks/`):

```ts
import { randomUUID } from "node:crypto";
import { AppError } from "../../core/api/errors.js";
import type { AppContext, BackendAppModule } from "../../core/app-registry/types.js";

type ItemRow = { id: string; title: string; created_at: string };

const id = "new_app";

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.post<{ Body: { title: string } }>(
    "/items",
    {
      schema: {
        body: {
          type: "object", required: ["title"], additionalProperties: false,
          properties: { title: { type: "string", minLength: 1, maxLength: 300 } },
        },
      },
    },
    async (request, reply) => {
      const { rows } = await db.query<ItemRow>(
        "INSERT INTO new_app.items (id, title) VALUES ($1, $2) RETURNING id, title, created_at",
        [randomUUID(), request.body.title],
      );
      return reply.code(201).send(rows[0]);
    },
  );

  ctx.api.delete<{ Params: { id: string } }>("/items/:id", async (request, reply) => {
    const result = await db.query("DELETE FROM new_app.items WHERE id = $1", [request.params.id]);
    if (result.rowCount === 0) throw new AppError(404, "not_found", "item not found");
    return reply.code(204).send();
  });
}

const app: BackendAppModule = { id, registerApi };
export default app;
```

## Frontend module

`frontend/src/apps/new_app/index.tsx` default-exports a `FrontendAppModule`
with `routes` (paths relative to the app root; `""` is the home page) and
optional `widgets` (ids must match `app.yaml`; the dashboard renders each
widget via `render()`). `NewAppPage` below is the scaffolded page component:

```tsx
import { api } from "../../shared/api";
import { useAsync } from "../../shared/useAsync";
import type { FrontendAppModule } from "../../shared/appTypes";

function NewAppCountWidget() {
  const summary = useAsync(() => api<{ count: number }>("/api/apps/new_app/summary"));
  if (summary.loading || summary.error) return <p className="muted">{summary.error ?? "Loading…"}</p>;
  return <p>{summary.data?.count ?? 0} items</p>;
}

const app: FrontendAppModule = {
  id: "new_app",
  routes: [{ path: "", label: "New App", element: <NewAppPage /> }],
  widgets: [{ id: "count", title: "New App Count", render: () => <NewAppCountWidget /> }],
};

export default app;
```

## App-private settings

App-private settings should live in the app's own schema (precedent: the focus
app): store them in a table created by your migration and expose them through
`ctx.api` routes. `/api/core/settings` is reserved for platform-level settings
such as the dashboard layout.

## Checklist

1. `npm run create:app -- <id> "Name"` — scaffolds and refreshes the generated
   module tables (`backend/src/generated/apps.ts`, `frontend/src/generated/apps.ts`).
2. Edit `app.yaml`; write the first forward-only migration; run `npm run migration:up`.
3. Implement the backend module (`registerApi`) and the frontend module (routes, widgets).
4. Register UI metadata: icon + accent in `frontend/src/shared/ui/appIcons.ts`
   and a `[data-app="<id>"]` accent scope in `frontend/src/styles/tokens.css`.
5. Re-run `npm run generate:apps` after adding module files; verify with
   `npm run check && npm test && npm run test:integration`.
