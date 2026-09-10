import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api";
import { useAppDisplayName } from "../../shared/PresentationContext";
import type { FrontendAppModule } from "../../shared/appTypes";
import { PixelBadge } from "../../shared/ui/PixelBadge";
import { PixelButton } from "../../shared/ui/PixelButton";
import { StatusMessage } from "../../shared/ui/StatusMessage";
import { LoadingState } from "../../shared/ui/LoadingState";
import { useAsync } from "../../shared/useAsync";
import { usePulseOnChange } from "../../shared/motion/usePulseOnChange";
import logo from "./assets/logo.svg";
import {
  applyMove,
  boardFromTiles,
  canMove,
  isValidBoard,
  keyToDirection,
  SIZE,
  spawnTileInTiles,
  tilesFromBoard,
  type Board,
  type Tile,
} from "./logic";

interface SaveState {
  score: number;
  highScore: number;
  board: Board;
  revision: number;
}

/** Two random tiles, matching the old spawnTile(spawnTile(emptyBoard())) run. */
function freshTiles(): Tile[] {
  const first = spawnTileInTiles([]);
  return [first, spawnTileInTiles([first])];
}

/**
 * One cell pitch for the tile overlay: the tile's own width (100%) plus one
 * grid gap. translate() percentages refer to the element's own size, so
 * translating by r/c pitches lands exactly on grid cell (r, c) — the board
 * grid uses the same --space-1 gap.
 */
function tileTransform(r: number, c: number): string {
  const pitch = "(100% + var(--space-1))";
  return `translate(calc(${c} * ${pitch}), calc(${r} * ${pitch}))`;
}

/**
 * Presentation-only move hints (FE-MOTION-4): which tile just spawned or
 * merged, for CSS mount/merge keyframes. `seq` increments per accepted move;
 * its parity alternates the data-attribute value so a tile merging on
 * consecutive moves replays its keyframes (a stable value would not restart
 * a running-name animation). Nothing here ever feeds back into game state.
 */
interface MoveFx {
  seq: number;
  mergedIds: number[];
  spawnId: number | null;
}

const NO_FX: MoveFx = { seq: 0, mergedIds: [], spawnId: null };

export function Game2048() {
  const displayName = useAppDisplayName({ id: "mini_game", name: "Mini Game (2048)" });
  // Loading gate (FP-13.1): the initial board is NOT randomized until the
  // save round-trip finishes, and moves / New Game are blocked while loading
  // so user input can never interleave with the async load.
  const [phase, setPhase] = useState<"loading" | "ready">("loading");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [score, setScore] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const [over, setOver] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [moveFx, setMoveFx] = useState<MoveFx>(NO_FX);
  // Monotonic local revision: every accepted local state bumps it, and the
  // backend rejects writes whose revision is not newer, so a slow older save
  // can never overwrite a newer board (FP-2A.4).
  const revision = useRef(0);

  const loadSave = useCallback(async () => {
    try {
      const body = await api<{ save: SaveState | null }>("/api/apps/mini_game/saves");
      // Defensive validation (FP-13.2): a corrupted board never renders; the
      // player simply gets a fresh run.
      if (body.save && isValidBoard(body.save.board)) {
        setTiles(tilesFromBoard(body.save.board));
        setScore(body.save.score);
        setHighScore(body.save.highScore);
        revision.current = body.save.revision;
        setMoveFx(NO_FX);
        setPhase("ready");
        return;
      }
    } catch {
      // Offline / error: fall through to a fresh local run.
    }
    setTiles(freshTiles());
    setScore(0);
    setOver(false);
    setMoveFx(NO_FX);
    setPhase("ready");
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
    void loadSave();
  }, [loadSave]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const direction = keyToDirection(event.key);
      if (!direction || over || phase !== "ready") return;
      event.preventDefault();
      const result = applyMove(tiles, direction);
      if (!result.moved) return;
      const spawned = spawnTileInTiles(result.tiles);
      const nextTiles = [...result.tiles, spawned];
      const nextBoard = boardFromTiles(nextTiles);
      const nextScore = score + result.gained;
      setTiles(nextTiles);
      setScore(nextScore);
      setHighScore((current) => Math.max(current, nextScore));
      setOver(!canMove(nextBoard));
      setMoveFx((fx) => ({ seq: fx.seq + 1, mergedIds: result.mergedIds, spawnId: spawned.id }));
      void save(nextBoard, nextScore);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tiles, score, over, phase, save]);

  function newGame() {
    if (phase !== "ready") return;
    const fresh = freshTiles();
    setTiles(fresh);
    setScore(0);
    setOver(false);
    setMoveFx(NO_FX);
    // New Game resets the run only; the historical high score stays.
    void save(boardFromTiles(fresh), 0);
  }

  const occupiedCells = useMemo(() => {
    const occupied = new Set<number>();
    for (const tile of tiles) occupied.add(tile.r * SIZE + tile.c);
    return occupied;
  }, [tiles]);
  // Parity string ("0"/"1") alternates per accepted move; see MoveFx above.
  const fxParity = moveFx.seq % 2 === 0 ? "0" : "1";

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
        <PixelButton onClick={newGame} disabled={phase !== "ready"}>
          New Game
        </PixelButton>
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
      {phase === "loading" ? (
        <LoadingState label="Loading save…" />
      ) : (
      <div className={over ? "game__board game__board--over" : "game__board"}>
        {/* Background grid: exactly 16 .game__cell slots. The empty span mark
            * keeps occupied cells :not(:empty) for the e2e contract; the value
            * itself lives on the tile overlay above. */}
        {Array.from({ length: SIZE * SIZE }, (_, index) => {
          const r = Math.floor(index / SIZE);
          const c = index % SIZE;
          return (
            <div key={`${r}-${c}`} className="game__cell game__cell--0">
              {occupiedCells.has(r * SIZE + c) ? (
                <span className="game__cell-mark" aria-hidden="true" />
              ) : null}
            </div>
          );
        })}
        {/* Tile overlay: one DOM node per tile id, so a move only changes the
            * inline transform and CSS transitions the slide. */}
        <div className="game__tiles">
          {tiles.map((tile) => (
            <div
              key={tile.id}
              className={`game__tile game__tile--${tile.value}`}
              style={{ transform: tileTransform(tile.r, tile.c) }}
              data-merged={moveFx.mergedIds.includes(tile.id) ? fxParity : undefined}
              data-spawn={moveFx.spawnId === tile.id ? fxParity : undefined}
            >
              {tile.value}
            </div>
          ))}
        </div>
      </div>
      )}
      {over && (
        <StatusMessage tone="warning" className="game__over">
          <p>Game over — press New Game.</p>
        </StatusMessage>
      )}
      <p className="game__hint">Arrow keys (or WASD) to move tiles.</p>
    </div>
  );
}

/**
 * High-score dashboard widget. The HISTORICAL high score stays the lead
 * metric (FP-2A.3); the saved run (same GET /saves the game loads) adds the
 * current score, the best tile and a miniature of the live board — existing
 * data only, no new statistics surface. No save yet: the hollow board keeps
 * the card composed.
 */
function HighScoreWidget() {
  const summary = useAsync(() => api<{ highScore: number }>("/api/apps/mini_game/summary"));
  const run = useAsync(() => api<{ save: SaveState | null }>("/api/apps/mini_game/saves"));
  const scorePulse = usePulseOnChange<number, HTMLSpanElement>(summary.data?.highScore ?? 0);
  if (summary.loading || run.loading) return <LoadingState label="Loading…" />;
  const error = summary.error ?? run.error;
  if (error) {
    return (
      <div className="widget-fallback">
        <StatusMessage tone="error">
          <p>{error}</p>
        </StatusMessage>
        {summary.error ? (
          <PixelButton size="sm" variant="secondary" onClick={summary.reload}>
            Retry
          </PixelButton>
        ) : null}
      </div>
    );
  }

  const board = run.data?.save?.board ?? null;
  const currentScore = run.data?.save?.score ?? 0;
  const bestTile = board ? Math.max(0, ...board.flat()) : 0;
  const hasRun = currentScore > 0 || bestTile > 0;

  return (
    <div className="game-widget">
      <div className="game-widget__best">
        <span className="game-widget__label">HIGH SCORE</span>
        <span className="game-widget__best-value" ref={scorePulse}>
          {summary.data?.highScore ?? 0}
        </span>
      </div>
      <div className="game-widget__run">
        <div className="game-widget__run-stat">
          <span className="game-widget__label">CURRENT</span>
          <span className="game-widget__run-value">{hasRun ? currentScore : "—"}</span>
        </div>
        <div className="game-widget__run-stat">
          <span className="game-widget__label">BEST TILE</span>
          <span className="game-widget__run-value">{hasRun ? bestTile : "—"}</span>
        </div>
      </div>
      {/* Miniature of the saved board (dashboard empty-state rule): the real
       * tiles when a run exists, hollow cells otherwise. */}
      <div className="game-widget__tiles" aria-hidden="true">
        {Array.from({ length: SIZE * SIZE }, (_, index) => {
          const value = board?.[Math.floor(index / SIZE)]?.[index % SIZE] ?? 0;
          return (
            <span
              key={index}
              className={value > 0 ? "game-widget__tile game-widget__tile--on" : "game-widget__tile"}
            >
              {value > 0 ? value : ""}
            </span>
          );
        })}
      </div>
      <p className="game-widget__hint">{hasRun ? "Run in progress — beat it on the board." : "Beat it on the board."}</p>
    </div>
  );
}

const app: FrontendAppModule = {
  id: "mini_game",
  routes: [{ path: "", label: "2048", element: <Game2048 /> }],
  widgets: [
    {
      id: "highscore",
      title: "2048 High Score",
      render: () => <HighScoreWidget />,
      /* Wide companion of the notes band (composition pass): hosts the high
       * score hero plus the current-run stats from the saved board. */
      layout: { minW: 12, minH: 12, defaultW: 31, defaultH: 18, defaultOrder: 31 },
    },
  ],
};

export default app;
