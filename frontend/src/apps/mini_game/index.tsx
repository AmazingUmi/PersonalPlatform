import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../shared/api";
import { useAppDisplayName } from "../../shared/PresentationContext";
import type { FrontendAppModule } from "../../shared/appTypes";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { LoadingState } from "../../shared/ui/LoadingState";
import { useAsync } from "../../shared/useAsync";
import logo from "./assets/logo.svg";
import {
  canMove,
  emptyBoard,
  keyToDirection,
  moveBoard,
  spawnTile,
  type Board,
} from "./logic";

interface SaveState {
  score: number;
  highScore: number;
  board: Board;
  revision: number;
}

function Game2048() {
  const displayName = useAppDisplayName({ id: "mini_game", name: "Mini Game (2048)" });
  const [board, setBoard] = useState<Board>(() => spawnTile(spawnTile(emptyBoard())));
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [over, setOver] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // Monotonic local revision: every accepted local state bumps it, and the
  // backend rejects writes whose revision is not newer, so a slow older save
  // can never overwrite a newer board (FP-2A.4).
  const revision = useRef(0);

  const loadSave = useCallback(async () => {
    const body = await api<{ save: SaveState | null }>("/api/apps/mini_game/saves");
    if (body.save && body.save.board.length === 4) {
      setBoard(body.save.board);
      setScore(body.save.score);
      setHighScore(body.save.highScore);
      revision.current = body.save.revision;
    }
  }, []);

  const save = useCallback(async (nextBoard: Board, nextScore: number) => {
    setSaveState("saving");
    const nextRevision = revision.current + 1;
    revision.current = nextRevision;
    try {
      const body = await api<{ save: SaveState; accepted: boolean }>("/api/apps/mini_game/saves", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ score: nextScore, board: nextBoard, revision: nextRevision }),
      });
      setHighScore(body.save.highScore);
      // A rejected write means the server already holds a newer revision; keep
      // the local (newer) state and continue numbering above the server.
      if (!body.accepted) revision.current = Math.max(revision.current, body.save.revision);
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
      const direction = keyToDirection(event.key);
      if (!direction || over) return;
      event.preventDefault();
      const result = moveBoard(board, direction);
      if (!result.moved) return;
      const nextBoard = spawnTile(result.board);
      const nextScore = score + result.gained;
      setBoard(nextBoard);
      setScore(nextScore);
      setHighScore((current) => Math.max(current, nextScore));
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
    // New Game resets the run only; the historical high score stays.
    void save(fresh, 0);
  }

  return (
    <div className="page game" data-app="mini_game">
      <header className="page-header">
        <h1 className="game__title page-header__title">
          <img src={logo} alt="" width={36} height={36} className="game__logo" /> 2048
        </h1>
        <p className="page-header__subtitle">{displayName}</p>
      </header>
      <div className="game__bar">
        <div className="game__score" aria-label="Score">
          <span className="game__score-label">Score</span>
          <span className="game__score-value">{score}</span>
        </div>
        <div className="game__score" aria-label="High score">
          <span className="game__score-label">Best</span>
          <span className="game__score-value">{highScore}</span>
        </div>
        <PixelButton onClick={newGame}>New Game</PixelButton>
        <PixelBadge
          tone={saveState === "error" ? "danger" : saveState === "saved" ? "success" : "neutral"}
        >
          {saveState === "saving"
            ? "Saving…"
            : saveState === "saved"
              ? "Saved"
              : saveState === "error"
                ? "Save failed"
                : "Idle"}
        </PixelBadge>
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
      {over && (
        <StatusMessage tone="warning" className="game__over">
          <p>Game over — press New Game.</p>
        </StatusMessage>
      )}
      <p className="game__hint">Arrow keys (or WASD) to move tiles.</p>
    </div>
  );
}

function HighScoreWidget() {
  const summary = useAsync(() => api<{ highScore: number }>("/api/apps/mini_game/summary"));
  if (summary.loading) return <LoadingState label="Loading…" />;
  if (summary.error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{summary.error}</p>
        </StatusMessage>
      </div>
    );
  }
  return (
    <div className="px-stats">
      <div className="px-stat">
        <span className="px-stat__label">High Score</span>
        <span className="px-stat__value px-stat__value--lg">{summary.data?.highScore ?? 0}</span>
      </div>
    </div>
  );
}

const app: FrontendAppModule = {
  id: "mini_game",
  routes: [{ path: "", label: "2048", element: <Game2048 /> }],
  widgets: [{ id: "highscore", title: "2048 High Score", render: () => <HighScoreWidget /> }],
};

export default app;
