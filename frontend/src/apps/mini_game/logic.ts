/**
 * Pure 2048 board logic (FP-2A). Extracted from the component so movement
 * transforms are deterministically testable.
 */
export type Board = number[][];
export type Direction = "left" | "right" | "up" | "down";

export const SIZE = 4;

export function emptyBoard(): Board {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => 0));
}

/** Slide one row towards index 0, merging equal neighbours once each. */
export function slideLine(line: number[]): { line: number[]; gained: number } {
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

/** Rotate the board 90° clockwise: column c becomes row c, bottom-to-top. */
export function rotate(board: Board): Board {
  return board[0]!.map((_, col) => board.map((row) => row[col]!).reverse());
}

/**
 * Apply one move. Every direction is normalized to "slide left": right
 * reverses rows; up/down rotate the board first and rotate it back after.
 *
 * Directional correctness (FP-2A.1): with a clockwise rotate, moving UP must
 * rotate three times (so the TOP of a column lands at index 0), then rotate
 * once back. The previous implementation swapped these, reversing Up/Down.
 */
export function moveBoard(board: Board, direction: Direction): { board: Board; gained: number; moved: boolean } {
  let work = board.map((row) => [...row]);
  if (direction === "right") work = work.map((row) => [...row].reverse());
  if (direction === "up") work = rotate(rotate(rotate(work)));
  if (direction === "down") work = rotate(work);

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
  if (direction === "up") out = rotate(out);
  if (direction === "down") out = rotate(rotate(rotate(out)));

  return { board: out, gained, moved };
}

export function spawnTile(board: Board): Board {
  const empty: Array<[number, number]> = [];
  board.forEach((row, r) => row.forEach((value, c) => value === 0 && empty.push([r, c])));
  if (empty.length === 0) return board;
  const [r, c] = empty[Math.floor(Math.random() * empty.length)]!;
  const next = board.map((row) => [...row]);
  next[r]![c] = Math.random() < 0.9 ? 2 : 4;
  return next;
}

export function canMove(board: Board): boolean {
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

/** Recognized keyboard controls (FP-2A.2): arrows plus WASD, both cases. */
export function keyToDirection(key: string): Direction | undefined {
  const keyMap: Record<string, Direction> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    ArrowUp: "up",
    ArrowDown: "down",
    w: "up",
    a: "left",
    s: "down",
    d: "right",
    W: "up",
    A: "left",
    S: "down",
    D: "right",
  };
  return keyMap[key];
}

/** A tile is either empty (0) or a power of two (2, 4, 8, ...). */
function isTileValue(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return false;
  if (value === 0) return true;
  return (value & (value - 1)) === 0;
}

/**
 * Defensive save validation (FP-13.2): 4×4 integers, each 0 or a power of
 * two. Corrupted or hand-crafted server data is rejected instead of rendered.
 */
export function isValidBoard(board: unknown): board is Board {
  if (!Array.isArray(board) || board.length !== SIZE) return false;
  return board.every(
    (row) => Array.isArray(row) && row.length === SIZE && row.every((value) => isTileValue(value)),
  );
}

// ---------- Tile identity layer (FE-MOTION-4) ----------
//
// The board layer above stays the source of truth for saves, validation and
// game-over detection. This layer adds stable per-tile identity so the
// component can keep one DOM node per tile and let CSS animate moves. It is a
// strict parallel implementation of the same slide semantics; equivalence is
// pinned by tiles.test.ts. Nothing here depends on animation state.

export interface Tile {
  id: number;
  value: number;
  r: number;
  c: number;
}

export interface TileMove {
  id: number;
  from: { r: number; c: number };
  to: { r: number; c: number };
}

export interface TileMoveResult {
  /** Post-move tiles (pre-spawn); a merged pair collapses to the survivor. */
  tiles: Tile[];
  /** Score gained — identical to moveBoard's gained for the same board. */
  gained: number;
  /** True when any tile changed position or merged (matches moveBoard). */
  moved: boolean;
  /** Position changes of surviving tiles (presentation-only). */
  movements: TileMove[];
  /** Ids of tiles that merged this move (the surviving ones). */
  mergedIds: number[];
}

/** Monotonic id source; uniqueness only has to hold within one board. */
let tileIdCounter = 0;

function nextTileId(): number {
  tileIdCounter += 1;
  return tileIdCounter;
}

/** Rebuild the positional board from tiles (saves, canMove, game over). */
export function boardFromTiles(tiles: Tile[], size: number = SIZE): number[][] {
  const board = Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  for (const tile of tiles) {
    if (tile.r >= 0 && tile.r < size && tile.c >= 0 && tile.c < size) {
      board[tile.r]![tile.c] = tile.value;
    }
  }
  return board;
}

/** Fresh ids, row-major — the load path after isValidBoard accepted a save. */
export function tilesFromBoard(board: number[][]): Tile[] {
  const tiles: Tile[] = [];
  board.forEach((row, r) =>
    row.forEach((value, c) => {
      if (value !== 0) tiles.push({ id: nextTileId(), value, r, c });
    }),
  );
  return tiles;
}

/**
 * Structural spawn parity with spawnTile: first rng draw picks a random empty
 * cell, second decides 2 @90% / 4 @10%. Throws when no cell is empty — the
 * component only spawns after a move that compacted the board, so that state
 * is unreachable there.
 */
export function spawnTileInTiles(tiles: Tile[], rng: () => number = Math.random): Tile {
  const occupied = new Set(tiles.map((tile) => tile.r * SIZE + tile.c));
  const empty: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      if (!occupied.has(r * SIZE + c)) empty.push({ r, c });
    }
  }
  const cell = empty[Math.floor(rng() * empty.length)];
  if (!cell) throw new Error("spawnTileInTiles: no empty cell available");
  return { id: nextTileId(), value: rng() < 0.9 ? 2 : 4, r: cell.r, c: cell.c };
}

/**
 * applyMove is moveBoard with identity: each move groups tiles into lines
 * ordered from the destination edge (the same normalization moveBoard does by
 * reversing/rotating), then slides with slideLine's exact pairing — equal
 * neighbours merge once, single consume, a tile merged this move never merges
 * again within the same move. The surviving tile of a merge keeps the id of
 * the pair member closer to the move direction (first in slide order) and
 * doubles its value; the other tile is removed.
 */
export function applyMove(tiles: Tile[], direction: Direction): TileMoveResult {
  const horizontal = direction === "left" || direction === "right";
  const reverse = direction === "right" || direction === "down";

  const lines: Tile[][] = Array.from({ length: SIZE }, () => []);
  for (const tile of tiles) {
    const key = horizontal ? tile.r : tile.c;
    if (key >= 0 && key < SIZE) lines[key]!.push(tile);
  }
  for (const line of lines) {
    line.sort((a, b) => (horizontal ? a.c - b.c : a.r - b.r));
    if (reverse) line.reverse();
  }

  const resultTiles: Tile[] = [];
  const movements: TileMove[] = [];
  const mergedIds: number[] = [];
  let gained = 0;
  let moved = false;

  lines.forEach((line, lineIndex) => {
    // slideLine pairing over non-zero values, tracked with tile identity.
    const kept: Array<{ tile: Tile; merged: boolean }> = [];
    let i = 0;
    while (i < line.length) {
      const current = line[i]!;
      const next = line[i + 1];
      if (next && current.value === next.value) {
        kept.push({ tile: { ...current, value: current.value * 2 }, merged: true });
        gained += current.value * 2;
        mergedIds.push(current.id);
        i += 2;
      } else {
        kept.push({ tile: current, merged: false });
        i += 1;
      }
    }
    kept.forEach(({ tile, merged }, slot) => {
      const r = horizontal ? lineIndex : reverse ? SIZE - 1 - slot : slot;
      const c = horizontal ? (reverse ? SIZE - 1 - slot : slot) : lineIndex;
      if (tile.r !== r || tile.c !== c) {
        movements.push({ id: tile.id, from: { r: tile.r, c: tile.c }, to: { r, c } });
        moved = true;
      }
      if (merged) moved = true;
      resultTiles.push(tile.r === r && tile.c === c ? tile : { ...tile, r, c });
    });
  });

  return { tiles: resultTiles, gained, moved, movements, mergedIds };
}
