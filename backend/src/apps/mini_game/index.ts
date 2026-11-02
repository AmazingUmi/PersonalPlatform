import { AppError } from "../../core/api/errors.js";
import type { AppContext, AppHealth, BackendAppModule } from "../../core/app-registry/types.js";
import {
  assertPresentedHash, editorBaseHash, lockOwnedTables, lockOwnerSet, parseSnapshotRow, readPresentedHash, singletonBaseHash, syncWriteFenced,
} from "../../core/data-management/sync-fence.js";

interface SaveRow {
  id: string;
  score: number;
  high_score: number;
  board: unknown;
  revision: number;
  updated_at: string;
}

const SAVE_ID = "current";

function absentSaveHash(): string {
  return singletonBaseHash("mini_game.saves", { id: SAVE_ID, absent: true });
}

function saveHash(snapshot: string): string {
  return editorBaseHash([{ table: "mini_game.saves", row: parseSnapshotRow(snapshot) }]);
}

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

function saveFromSnapshot(snapshot: string): SaveRow {
  const row = parseSnapshotRow(snapshot);
  return {
    id: String(row.id),
    score: Number(row.score),
    high_score: Number(row.high_score),
    board: row.board,
    revision: Number(row.revision),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : String(row.updated_at),
  };
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

  ctx.api.get("/saves", async (request) => {
    const user = await ctx.auth.requireUser(request);
    const { rows } = await db.query<SaveRow & { snapshot: string }>(
      `SELECT id, score, high_score, board, revision, updated_at, row_to_json(s)::text AS snapshot
       FROM mini_game.saves s WHERE id = $1 AND user_id = $2`,
      [SAVE_ID, user.id],
    );
    if (!rows[0]) return { save: null, baseHash: absentSaveHash() };
    const baseHash = saveHash(rows[0].snapshot);
    if (!isValidBoardShape(rows[0].board)) return { save: null, baseHash };
    return { save: toSave(rows[0]), baseHash };
  });

  ctx.api.put<{ Body: { score: number; board: unknown; revision: number; baseHash?: string } }>(
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
            baseHash: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const user = await ctx.auth.requireUser(request);
      const body = request.body;
      const presented = readPresentedHash(body.baseHash);

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
      // The save slot is per-user (AUTH-3): (user_id, id) is the conflict key.
      const { row, rejected, prevHigh, existed, baseHash } = await db.withTransaction(async (tx) => {
        await lockOwnedTables(tx, ["mini_game.saves"]);
        await lockOwnerSet(tx, user.id, "mini_game.saves");
        const prev = await tx.query<{ high_score: number; snapshot: string }>(
          "SELECT high_score, row_to_json(s)::text AS snapshot FROM mini_game.saves s WHERE id = $1 AND user_id = $2 FOR UPDATE",
          [SAVE_ID, user.id],
        );
        const fenced = await syncWriteFenced(tx, user.id);
        if (!prev.rows[0]) {
          assertPresentedHash(fenced, presented, absentSaveHash());
          const inserted = await tx.query<SaveRow & { snapshot: string }>(
            `INSERT INTO mini_game.saves AS s (id, user_id, score, high_score, board, revision, updated_at)
             VALUES ($1, $2, $3, $3, $4::jsonb, $5, now())
             RETURNING id, score, high_score, board, revision, updated_at, row_to_json(s)::text AS snapshot`,
            [SAVE_ID, user.id, body.score, JSON.stringify(body.board), body.revision],
          );
          const insertedRow = inserted.rows[0];
          if (!insertedRow) throw new AppError(500, "save_failed", "save state could not be read back");
          return { row: insertedRow, rejected: undefined, prevHigh: undefined, existed: false, baseHash: saveHash(insertedRow.snapshot) };
        }
        const lockedHash = saveHash(prev.rows[0].snapshot);
        assertPresentedHash(fenced, presented, lockedHash);
        const { rows } = await tx.query<SaveRow & { snapshot: string }>(
          `INSERT INTO mini_game.saves AS s (id, user_id, score, high_score, board, revision, updated_at)
           VALUES ($1, $2, $3, $3, $4::jsonb, $5, now())
           ON CONFLICT (user_id, id) DO UPDATE
             SET score = EXCLUDED.score,
                 high_score = GREATEST(s.high_score, EXCLUDED.score),
                 board = EXCLUDED.board,
                 revision = EXCLUDED.revision,
                 updated_at = now()
           WHERE s.revision < EXCLUDED.revision
           RETURNING id, score, high_score, board, revision, updated_at, row_to_json(s)::text AS snapshot`,
          [SAVE_ID, user.id, body.score, JSON.stringify(body.board), body.revision],
        );
        if (!rows[0]) {
          return {
            row: undefined,
            rejected: saveFromSnapshot(prev.rows[0].snapshot),
            prevHigh: prev.rows[0].high_score,
            existed: true,
            baseHash: lockedHash,
          };
        }
        return {
          row: rows[0],
          rejected: undefined,
          prevHigh: prev.rows[0].high_score,
          existed: true,
          baseHash: saveHash(rows[0].snapshot),
        };
      });

      const accepted = row !== undefined;
      // Stale or repeated revision: the locked snapshot and its hash travel together.
      if (!row) {
        if (!rejected) throw new AppError(500, "save_failed", "save state could not be read back");
        return { save: toSave(rejected), accepted: false, baseHash };
      }

      // The historical high score is monotonic: resetting the run (New Game)
      // never lowers it. Publish only when the persisted record was actually
      // exceeded (a first-ever score has no record to beat).
      if (existed && body.score > (prevHigh ?? 0)) {
        ctx.events.publish(
          "mini_game.highscore.beaten.v1",
          { userId: user.id, score: row.high_score, previous: prevHigh },
          "mini_game",
        );
      }
      return { save: toSave(row), accepted, baseHash };
    },
  );

  ctx.api.get("/summary", async (request) => {
    const user = await ctx.auth.requireUser(request);
    // The dashboard widget must show the HISTORICAL high score, not the
    // current run's score (FP-2A.3).
    const { rows } = await db.query<{ high_score: number }>(
      "SELECT high_score FROM mini_game.saves WHERE id = $1 AND user_id = $2",
      [SAVE_ID, user.id],
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
