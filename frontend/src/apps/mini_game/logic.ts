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
