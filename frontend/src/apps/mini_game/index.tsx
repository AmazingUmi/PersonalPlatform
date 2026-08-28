import { useCallback, useEffect, useState } from "react";
import { api } from "../../shared/api";
import type { FrontendAppModule } from "../../shared/appTypes";
import { useAsync } from "../../shared/useAsync";

type Board = number[][];
type Direction = "left" | "right" | "up" | "down";

const SIZE = 4;

function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0));
}

function slideLine(line: number[]): { line: number[]; gained: number } {
  const values = line.filter((v) => v !== 0);
  const merged: number[] = [];
  let gained = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === values[i + 1]) {
      const value = (values[i] ?? 0) * 2;
      merged.push(value);
      gained += value;
      i += 1;
    } else {
      merged.push(values[i] ?? 0);
    }
  }
  while (merged.length < SIZE) merged.push(0);
  return { line: merged, gained };
}

function rotate(board: Board): Board {
  return board[0]!.map((_, col) => board.map((row) => row[col]!).reverse());
}

function moveBoard(board: Board, direction: Direction): { board: Board; gained: number; moved: boolean } {
  let work = board.map((row) => [...row]);
  if (direction === "right") work = work.map((row) => [...row].reverse());
  if (direction === "up") work = rotate(work);
  if (direction === "down") work = rotate(rotate(rotate(work)));

  let gained = 0;
  let moved = false;
  const slid = work.map((row) => {
    const result = slideLine(row);
    gained += result.gained;
    if (result.line.join(",") !== row.join(",")) moved = true;
    return result.line;
  });

  let out = slid;
  if (direction === "right") out = out.map((row) => [...row].reverse());
  if (direction === "up") out = rotate(rotate(rotate(out)));
  if (direction === "down") out = rotate(out);

  return { board: out, gained, moved };
}

function spawnTile(board: Board): Board {
  const empty: Array<[number, number]> = [];
  board.forEach((row, r) => row.forEach((value, c) => value === 0 && empty.push([r, c])));
  if (empty.length === 0) return board;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)]!;
  const next = board.map((row) => [...row]);
  next[r]![c] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

function canMove(board: Board): boolean {
  if (board.some((row) => row.some((value) => value === 0))) return true;
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const value = board[r]![c]!;
      if (r + 1 < SIZE && board[r + 1]![c] === value) return true;
      if (c + 1 < SIZE && board[r]![c + 1] === value) return true;
    }
  }
  return false;
}

function Game2048() {
  const [board, setBoard] = useState<Board>(() => spawnTile(spawnTile(emptyBoard())));
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const loadSave = useCallback(async () => {
    const body = await api<{ save: { score: number; board: Board } | null }>("/api/apps/mini_game/saves");
    if (body.save && body.save.board.length === SIZE) {
      setBoard(body.save.board);
      setScore(body.save.score);
    }
  }, []);

  const save = useCallback(async (nextBoard: Board, nextScore: number) => {
    setSaveState("saving");
    try {
      await api("/api/apps/mini_game/saves", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ score: nextScore, board: nextBoard }),
      });
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, []);

  useEffect(() => {
    void loadSave().catch(() => undefined);
  }, [loadSave]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const keyMap: Record<string, Direction> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      const direction = keyMap[event.key];
      if (!direction || over) return;
      event.preventDefault();
      const result = moveBoard(board, direction);
      if (!result.moved) return;
      const nextBoard = spawnTile(result.board);
      const nextScore = score + result.gained;
      setBoard(nextBoard);
      setScore(nextScore);
      setOver(!canMove(nextBoard));
      void save(nextBoard, nextScore);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [board, score, over, save]);

  function newGame() {
    const fresh = spawnTile(spawnTile(emptyBoard()));
    setBoard(fresh);
    setScore(0);
    setOver(false);
    void save(fresh, 0);
  }

  return (
    <div className="page game">
      <h1>2048</h1>
      <div className="game__bar">
        <strong>Score: {score}</strong>
        <button type="button" onClick={newGame}>
          New Game
        </button>
        <span className="muted">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
        </span>
      </div>
      <div className="game__board">
        {board.map((row, r) => (
          <div key={r} className="game__row">
            {row.map((value, c) => (
              <div key={c} className={`game__cell game__cell--${value}`}>
                {value !== 0 ? value : ""}
              </div>
            ))}
          </div>
        ))}
      </div>
      {over && <p className="error-text">Game over — press New Game.</p>}
      <p className="muted">Use arrow keys (or WASD) to move tiles.</p>
    </div>
  );
}

function HighScoreWidget() {
  const summary = useAsync(() => api<{ highScore: number }>("/api/apps/mini_game/summary"));
  if (summary.loading) return <p className="muted">Loading…</p>;
  if (summary.error) return <p className="error-text">{summary.error}</p>;
  return <p>High score: {summary.data?.highScore ?? 0}</p>;
}

const app: FrontendAppModule = {
  id: "mini_game",
  routes: [{ path: "", label: "2048", element: <Game2048 /> }],
  widgets: [{ id: "highscore", title: "2048 High Score", render: () => <HighScoreWidget /> }],
};

export default app;
