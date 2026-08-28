import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";

interface SaveRow {
  id: string;
  score: number;
  board: unknown;
  updated_at: string;
}

const SAVE_ID = "current";

const id = "mini_game";

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get("/saves", async () => {
    const { rows } = await db.query<SaveRow>(
      "SELECT id, score, board, updated_at FROM mini_game.saves WHERE id = $1",
      [SAVE_ID],
    );
    if (!rows[0]) return { save: null };
    return { save: rows[0] };
  });

  ctx.api.put<{ Body: { score: number; board: unknown } }>(
    "/saves",
    {
      schema: {
        body: {
          type: "object",
          required: ["score", "board"],
          additionalProperties: false,
          properties: {
            score: { type: "integer", minimum: 0 },
            board: { type: "array" },
          },
        },
      },
    },
    async (request) => {
      const previous = await db.query<SaveRow>(
        "SELECT score FROM mini_game.saves WHERE id = $1",
        [SAVE_ID],
      );
      const prevScore = previous.rows[0]?.score ?? 0;

      const { rows } = await db.query<SaveRow>(
        `INSERT INTO mini_game.saves (id, score, board, updated_at)
         VALUES ($1, $2, $3::jsonb, now())
         ON CONFLICT (id) DO UPDATE
           SET score = EXCLUDED.score, board = EXCLUDED.board, updated_at = now()
         RETURNING id, score, board, updated_at`,
        [SAVE_ID, request.body.score, JSON.stringify(request.body.board)],
      );

      if (request.body.score > prevScore && prevScore > 0) {
        ctx.events.publish(
          "mini_game.highscore.beaten.v1",
          { score: request.body.score, previous: prevScore },
          "mini_game",
        );
      }
      return rows[0];
    },
  );

  ctx.api.get("/summary", async () => {
    const { rows } = await db.query<SaveRow>(
      "SELECT score FROM mini_game.saves WHERE id = $1",
      [SAVE_ID],
    );
    return { highScore: rows[0]?.score ?? 0 };
  });
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM mini_game.saves LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, healthcheck };
export default app;
