import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";

interface SaveRow {
  id: string;
  score: number;
  high_score: number;
  board: unknown;
  revision: number;
  updated_at: string;
}

const SAVE_ID = "current";

const id = "mini_game";

const BOARD_SCHEMA = {
  type: "array",
  minItems: 4,
  maxItems: 4,
  items: {
    type: "array",
    minItems: 4,
    maxItems: 4,
    items: { type: "integer", minimum: 0 },
  },
};

/** Every tile is empty (0) or a power of two (FP-13.2). */
function isPowerOfTwoOrNull(value: number): boolean {
  return value === 0 || (value & (value - 1)) === 0;
}

function isValidBoardShape(board: unknown): board is number[][] {
  return (
    Array.isArray(board) &&
    board.length === 4 &&
    board.every((row) => Array.isArray(row) && row.length === 4 && row.every((value) => isPowerOfTwoOrNull(value)))
  );
}

function toSave(row: SaveRow) {
  return {
    id: row.id,
    score: row.score,
    highScore: row.high_score,
    board: row.board,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

async function registerApi(ctx: AppContext): Promise<void> {
  const db = ctx.database;

  ctx.api.get("/saves", async () => {
    const { rows } = await db.query<SaveRow>(
      "SELECT id, score, high_score, board, revision, updated_at FROM mini_game.saves WHERE id = $1",
      [SAVE_ID],
    );
    // Defensive read (FP-13.2): a poisoned/stale row is reported as "no save"
    // instead of feeding the client a broken board.
    if (!rows[0] || !isValidBoardShape(rows[0].board)) return { save: null };
    return { save: toSave(rows[0]) };
  });

  ctx.api.put<{ Body: { score: number; board: unknown; revision: number } }>(
    "/saves",
    {
      schema: {
        body: {
          type: "object",
          required: ["score", "board", "revision"],
          additionalProperties: false,
          properties: {
            score: { type: "integer", minimum: 0 },
            board: BOARD_SCHEMA,
            revision: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body;

      // Business validation on top of the JSON shape (FP-13.2): shape errors
      // answer 400 validation_error, semantically impossible boards answer a
      // clean 422 domain error.
      if (!isValidBoardShape(body.board)) {
        throw new AppError(
          422,
          "invalid_board",
          "board must be 4x4 integers where every tile is 0 or a power of two",
        );
      }

      // Revision-guarded upsert: a stale write (server already holds a newer
      // revision) is rejected so rapid overlapping saves can never roll the
      // board back to an older state (FP-2A.4). The row lock makes the
      // previous-high-score read and the upsert atomic for concurrent moves.
      const { row, prevHigh, existed } = await db.withTransaction(async (tx) => {
        const prev = await tx.query<{ high_score: number }>(
          "SELECT high_score FROM mini_game.saves WHERE id = $1 FOR UPDATE",
          [SAVE_ID],
        );
        const { rows } = await tx.query<SaveRow>(
          `INSERT INTO mini_game.saves (id, score, high_score, board, revision, updated_at)
           VALUES ($1, $2, $2, $3::jsonb, $4, now())
           ON CONFLICT (id) DO UPDATE
             SET score = EXCLUDED.score,
                 high_score = GREATEST(mini_game.saves.high_score, EXCLUDED.score),
                 board = EXCLUDED.board,
                 revision = EXCLUDED.revision,
                 updated_at = now()
           WHERE mini_game.saves.revision < EXCLUDED.revision
           RETURNING id, score, high_score, board, revision, updated_at`,
          [SAVE_ID, body.score, JSON.stringify(body.board), body.revision],
        );
        return {
          row: rows[0],
          prevHigh: prev.rows[0]?.high_score,
          existed: prev.rows.length > 0,
        };
      });

      const accepted = row !== undefined;
      // Either the write was stale or it repeated the current revision
      // (idempotent no-op); return the authoritative server state.
      if (!row) {
        const existing = await db.query<SaveRow>(
          "SELECT id, score, high_score, board, revision, updated_at FROM mini_game.saves WHERE id = $1",
          [SAVE_ID],
        );
        if (!existing.rows[0]) throw new AppError(500, "save_failed", "save state could not be read back");
        return { save: toSave(existing.rows[0]), accepted: false };
      }

      // The historical high score is monotonic: resetting the run (New Game)
      // never lowers it. Publish only when the persisted record was actually
      // exceeded (a first-ever score has no record to beat).
      if (existed && body.score > (prevHigh ?? 0)) {
        ctx.events.publish(
          "mini_game.highscore.beaten.v1",
          { score: row.high_score, previous: prevHigh },
          "mini_game",
        );
      }
      return { save: toSave(row), accepted };
    },
  );

  ctx.api.get("/summary", async () => {
    // The dashboard widget must show the HISTORICAL high score, not the
    // current run's score (FP-2A.3).
    const { rows } = await db.query<{ high_score: number }>(
      "SELECT high_score FROM mini_game.saves WHERE id = $1",
      [SAVE_ID],
    );
    return { highScore: rows[0]?.high_score ?? 0 };
  });
}

async function healthcheck(ctx: AppContext): Promise<AppHealth> {
  await ctx.database.query("SELECT 1 FROM mini_game.saves LIMIT 1");
  return { status: "ok", checks: { database: { status: "ok" } } };
}

const app: BackendAppModule = { id, registerApi, healthcheck };
export default app;
